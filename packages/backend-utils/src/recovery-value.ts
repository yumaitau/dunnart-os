/** JSON data describing a capability, supplied only by a trusted recovery adapter. */
export type PortableDescriptor = null | boolean | number | string | PortableDescriptor[] | { [key: string]: PortableDescriptor };

/** Hooks map live capabilities to portable identities and rebind them on the destination. */
export interface RecoveryValueCodec {
  /** Recognize objects or function-shaped native capabilities; return undefined otherwise. */
  describe(value: object, path: string): PortableDescriptor | undefined | Promise<PortableDescriptor | undefined>;
  /** Resolve an authenticated descriptor to a destination capability. */
  restore(descriptor: PortableDescriptor): unknown | Promise<unknown>;
}

type Atom = null | boolean | string | number | { ref: number } | { special: string };
type Node =
  | { kind: 'object'; nullPrototype: boolean; entries: [string, Atom][] }
  | { kind: 'array'; length: number; entries: [string, Atom][] }
  | { kind: 'map'; entries: [Atom, Atom][] }
  | { kind: 'set'; values: Atom[] }
  | { kind: 'date'; value: Atom }
  | { kind: 'buffer'; bytes: string }
  | { kind: 'view'; type: string; buffer: Atom; offset: number; length: number }
  | { kind: 'capability'; descriptor: PortableDescriptor };

/** Versioned JSON-safe graph preserving aliases, cycles, and structured storage values. */
export interface PortableValue { version: 1; root: Atom; nodes: Node[] }

const views = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array,
  Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };
const fail = (path: string, reason: string): never => { throw new Error(`Recovery value at ${path}: ${reason}`); };
const child = (path: string, key: string) => `${path}[${JSON.stringify(key)}]`;

function descriptor(value: unknown, path: string, seen = new Set<object>()): PortableDescriptor {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) return fail(path, 'capability descriptor must be JSON data');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) return fail(path, 'sparse or extended descriptor array');
      return value.map((item, index) => descriptor(item, `${path}[${index}]`, seen));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return fail(path, 'capability descriptor must be plain JSON data');
    const result: { [key: string]: PortableDescriptor } = {};
    for (const key of Reflect.ownKeys(value)) {
      const prop = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || !prop.enumerable || !('value' in prop)) return fail(path, 'unsupported descriptor property');
      Object.defineProperty(result, key, { value: descriptor(prop.value, child(path, key), seen), enumerable: true, writable: true, configurable: true });
    }
    return result;
  } finally { seen.delete(value); }
}

/** Encode storage values; unsupported prototypes, accessors, and capabilities fail with their path. */
export async function encodePortableValue(value: unknown, codec?: RecoveryValueCodec): Promise<PortableValue> {
  const nodes: Node[] = [];
  const seen = new Map<object, number>();
  const visit = async (value: unknown, path: string): Promise<Atom> => {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : { special: Object.is(value, -0) ? '-0' : String(value) };
    if (typeof value === 'undefined') return { special: 'undefined' };
    if (typeof value === 'bigint') return { special: `bigint:${value}` };
    if (typeof value !== 'object' && typeof value !== 'function') return fail(path, `unsupported ${typeof value}`);
    const existing = seen.get(value);
    if (existing !== undefined) return { ref: existing };
    const index = nodes.length;
    seen.set(value, index);
    // Reserve before visiting children so cycles and shared references retain identity.
    nodes.push({ kind: 'object', nullPrototype: false, entries: [] });
    const capability = await codec?.describe(value, path);
    let node: Node;
    if (capability !== undefined) node = { kind: 'capability', descriptor: descriptor(capability, `${path}.descriptor`) };
    else if (typeof value === 'function') return fail(path, 'unsupported function');
    else if (value instanceof ArrayBuffer) {
      if (Object.getPrototypeOf(value) !== ArrayBuffer.prototype || Reflect.ownKeys(value).length) return fail(path, 'extended ArrayBuffer');
      let bytes = '';
      for (const byte of new Uint8Array(value)) bytes += String.fromCharCode(byte);
      node = { kind: 'buffer', bytes: btoa(bytes) };
    } else if (ArrayBuffer.isView(value)) {
      const type = Object.keys(views).find(name => Object.getPrototypeOf(value) === views[name as keyof typeof views].prototype);
      if (!type) return fail(path, 'unsupported typed array');
      if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key))) return fail(path, 'extended typed array');
      node = { kind: 'view', type, buffer: await visit(value.buffer, `${path}.buffer`), offset: value.byteOffset, length: value.byteLength };
    } else if (Object.getPrototypeOf(value) === Date.prototype) {
      if (Reflect.ownKeys(value).length) return fail(path, 'extended Date');
      node = { kind: 'date', value: await visit((value as Date).getTime(), `${path}.time`) };
    } else if (Object.getPrototypeOf(value) === Map.prototype) {
      if (Reflect.ownKeys(value).length) return fail(path, 'extended Map');
      const entries: [Atom, Atom][] = [];
      let i = 0;
      for (const [key, item] of value as Map<unknown, unknown>) entries.push([await visit(key, `${path}.map[${i}].key`), await visit(item, `${path}.map[${i++}].value`)]);
      node = { kind: 'map', entries };
    } else if (Object.getPrototypeOf(value) === Set.prototype) {
      if (Reflect.ownKeys(value).length) return fail(path, 'extended Set');
      const values: Atom[] = [];
      for (const item of value as Set<unknown>) values.push(await visit(item, `${path}.set[${values.length}]`));
      node = { kind: 'set', values };
    } else {
      const array = Array.isArray(value);
      const prototype = Object.getPrototypeOf(value);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return fail(path, 'unsupported object or unrecognized capability');
      const entries: [string, Atom][] = [];
      for (const key of Reflect.ownKeys(value)) {
        if (array && key === 'length') continue;
        const prop = Object.getOwnPropertyDescriptor(value, key)!;
        if (typeof key !== 'string' || !prop.enumerable || !('value' in prop)) return fail(path, `unsupported property ${String(key)}`);
        entries.push([key, await visit(prop.value, child(path, key))]);
      }
      node = array ? { kind: 'array', length: value.length, entries } : { kind: 'object', nullPrototype: prototype === null, entries };
    }
    nodes[index] = node;
    return { ref: index };
  };
  return { version: 1, root: await visit(value, '$'), nodes };
}

/** Decode an authenticated graph, resolving each capability once through the trusted adapter. */
export async function decodePortableValue(portable: PortableValue, codec?: RecoveryValueCodec): Promise<unknown> {
  if (!portable || portable.version !== 1 || !Array.isArray(portable.nodes)) return fail('$', 'invalid portable graph');
  const nodes = portable.nodes;
  const objects: unknown[] = new Array(nodes.length);
  const ready = new Set<number>();
  const resolving = new Set<number>();
  const atom = async (value: Atom, path: string): Promise<unknown> => {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (!value || typeof value !== 'object') return fail(path, 'invalid atom');
    if ('ref' in value && Number.isInteger(value.ref) && value.ref >= 0 && value.ref < nodes.length && Object.keys(value).length === 1) return resolve(value.ref);
    if ('special' in value && typeof value.special === 'string' && Object.keys(value).length === 1) {
      if (value.special === 'undefined') return undefined;
      if (value.special === '-0') return -0;
      if (value.special === 'NaN') return NaN;
      if (value.special === 'Infinity') return Infinity;
      if (value.special === '-Infinity') return -Infinity;
      if (/^bigint:-?(0|[1-9]\d*)$/.test(value.special)) return BigInt(value.special.slice(7));
    }
    return fail(path, 'invalid atom');
  };
  const resolve = async (index: number): Promise<unknown> => {
    if (ready.has(index)) return objects[index];
    if (resolving.has(index)) return fail(`$.nodes[${index}]`, 'invalid cyclic scalar');
    resolving.add(index);
    const node = nodes[index];
    const path = `$.nodes[${index}]`;
    if (!node || typeof node !== 'object') return fail(path, 'invalid node');
    let value: unknown;
    switch (node.kind) {
      case 'object':
        if (typeof node.nullPrototype !== 'boolean') return fail(path, 'invalid object');
        value = node.nullPrototype ? Object.create(null) : {};
        break;
      case 'array':
        if (!Number.isInteger(node.length) || node.length < 0 || node.length > 0xffffffff) return fail(path, 'invalid array length');
        value = new Array(node.length); break;
      case 'map': value = new Map(); break;
      case 'set': value = new Set(); break;
      case 'date': {
        const time = await atom(node.value, path);
        if (typeof time !== 'number') return fail(path, 'invalid Date');
        value = new Date(time); break;
      }
      case 'buffer': {
        if (typeof node.bytes !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(node.bytes)) return fail(path, 'invalid buffer');
        value = Uint8Array.from(atob(node.bytes), char => char.charCodeAt(0)).buffer; break;
      }
      case 'view': {
        const buffer = await atom(node.buffer, path);
        if (!(buffer instanceof ArrayBuffer) || !Object.hasOwn(views, node.type) || !Number.isSafeInteger(node.offset) || node.offset < 0 || !Number.isSafeInteger(node.length) || node.length < 0) return fail(path, 'invalid buffer view');
        if (node.type === 'DataView') value = new DataView(buffer, node.offset, node.length);
        else {
          const View = views[node.type as Exclude<keyof typeof views, 'DataView'>];
          if (node.length % View.BYTES_PER_ELEMENT) return fail(path, 'misaligned buffer view');
          value = new View(buffer, node.offset, node.length / View.BYTES_PER_ELEMENT);
        }
        break;
      }
      case 'capability':
        if (!codec) return fail(path, 'capability requires a trusted restore adapter');
        value = await codec.restore(descriptor(node.descriptor, path)); break;
      default: return fail(path, 'unsupported node kind');
    }
    objects[index] = value;
    ready.add(index);
    if (node.kind === 'array' || node.kind === 'object') {
      if (!Array.isArray(node.entries)) return fail(path, 'invalid properties');
      const keys = new Set<string>();
      for (const entry of node.entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || keys.has(entry[0]) || (node.kind === 'array' && (entry[0] === 'length' || (/^(0|[1-9]\d*)$/.test(entry[0]) && Number(entry[0]) >= node.length)))) return fail(path, 'invalid property');
        keys.add(entry[0]);
        Object.defineProperty(value, entry[0], { value: await atom(entry[1], child(path, entry[0])), enumerable: true, configurable: true, writable: true });
      }
    } else if (node.kind === 'map') {
      if (!Array.isArray(node.entries)) return fail(path, 'invalid map');
      for (const entry of node.entries) {
        if (!Array.isArray(entry) || entry.length !== 2) return fail(path, 'invalid map entry');
        const key = await atom(entry[0], path);
        const map = value as Map<unknown, unknown>;
        if (map.has(key)) return fail(path, 'duplicate map key');
        map.set(key, await atom(entry[1], path));
      }
    } else if (node.kind === 'set') {
      if (!Array.isArray(node.values)) return fail(path, 'invalid set');
      for (const entry of node.values) {
        const item = await atom(entry, path);
        const set = value as Set<unknown>;
        if (set.has(item)) return fail(path, 'duplicate set member');
        set.add(item);
      }
    }
    resolving.delete(index);
    return value;
  };
  const root = await atom(portable.root, '$');
  // Reject malformed or unrecognized nodes even if a corrupted root leaves them unreachable.
  for (let index = 0; index < nodes.length; index++) await resolve(index);
  return root;
}
