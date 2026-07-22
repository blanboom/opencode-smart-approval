import { describe, expect, test } from "bun:test";
import approvalPlugin from "../src/index";

type BoundaryCase = {
  readonly name: string;
  readonly make: () => {
    readonly input: unknown;
    readonly accesses: () => number;
    readonly expectedAccesses: number;
  };
};

const validClientShape = () => ({
  app: {
    agents: async () => ({ data: [] }),
    log: async () => ({ data: true }),
  },
  session: {
    messages: async () => ({ data: [] }),
    create: async () => ({ data: {} }),
    prompt: async () => ({ data: {} }),
    abort: async () => ({ data: true }),
    delete: async () => ({ data: true }),
  },
});

const staticCase = (name: string, input: unknown): BoundaryCase => ({
  name,
  make: () => ({ input, accesses: () => 0, expectedAccesses: 0 }),
});

const throwingRootCase = (name: string, proxy: boolean): BoundaryCase => ({
  name,
  make: () => {
    let accesses = 0;
    const source = { directory: process.cwd() };
    const input = proxy
      ? new Proxy(source, {
          get: (target, property, receiver) => {
            if (property === "client") {
              accesses += 1;
              throw new Error("secret-root-proxy");
            }
            return Reflect.get(target, property, receiver);
          },
        })
      : {
          ...source,
          get client() {
            accesses += 1;
            throw new Error("secret-root-getter");
          },
        };
    return { input, accesses: () => accesses, expectedAccesses: 1 };
  },
});

const throwingPrimitiveCase: BoundaryCase = {
  name: "throwing non-Error root client getter",
  make: () => {
    let accesses = 0;
    return {
      input: {
        directory: process.cwd(),
        get client() {
          accesses += 1;
          const rejection: unknown = "secret-primitive-throw";
          throw rejection;
        },
      },
      accesses: () => accesses,
      expectedAccesses: 1,
    };
  },
};

const throwingObjectCase = (property: "app" | "session"): BoundaryCase => ({
  name: `throwing client.${property} getter`,
  make: () => {
    let accesses = 0;
    const valid = validClientShape();
    const client = property === "app"
      ? {
          get app() {
            accesses += 1;
            throw new Error("secret-app-getter");
          },
          session: valid.session,
        }
      : {
          app: valid.app,
          get session() {
            accesses += 1;
            throw new Error("secret-session-getter");
          },
        };
    return {
      input: { directory: process.cwd(), client },
      accesses: () => accesses,
      expectedAccesses: 1,
    };
  },
});

const throwingMethodCase = (group: "app" | "session", method: string): BoundaryCase => ({
  name: `throwing client.${group}.${method} getter`,
  make: () => {
    let accesses = 0;
    const client = validClientShape();
    const receiver = group === "app" ? client.app : client.session;
    Object.defineProperty(receiver, method, {
      configurable: true,
      get: () => {
        accesses += 1;
        throw new Error(`secret-${group}-${method}`);
      },
    });
    return {
      input: { directory: process.cwd(), client },
      accesses: () => accesses,
      expectedAccesses: 1,
    };
  },
});

const malformedCases: readonly BoundaryCase[] = [
  staticCase("undefined plugin input", undefined),
  staticCase("null plugin input", null),
  staticCase("primitive plugin input", "primitive"),
  staticCase("missing client", { directory: process.cwd() }),
  staticCase("null client", { directory: process.cwd(), client: null }),
  staticCase("primitive client", { directory: process.cwd(), client: 7 }),
  staticCase("missing app object", { directory: process.cwd(), client: { session: validClientShape().session } }),
  staticCase("primitive session object", { directory: process.cwd(), client: { app: validClientShape().app, session: false } }),
  staticCase("missing client method", (() => {
    const client = validClientShape();
    Reflect.deleteProperty(client.session, "delete");
    return { directory: process.cwd(), client };
  })()),
  staticCase("non-callable client method", (() => {
    const client = validClientShape();
    Reflect.set(client.app, "agents", 42);
    return { directory: process.cwd(), client };
  })()),
  throwingRootCase("throwing root client getter", false),
  throwingRootCase("throwing root client proxy trap", true),
  throwingPrimitiveCase,
  throwingObjectCase("app"),
  throwingObjectCase("session"),
  ...(["agents", "log"] as const).map((method) => throwingMethodCase("app", method)),
  ...(["messages", "create", "prompt", "abort", "delete"] as const)
    .map((method) => throwingMethodCase("session", method)),
];

const invokeProductionServer = async (input: unknown): Promise<unknown> => {
  const server = approvalPlugin.server;
  if (!server) throw new TypeError("missing production server");
  return Reflect.apply(server, approvalPlugin, [input]);
};

const captureRejection = async (operation: Promise<unknown>): Promise<Error> => {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new TypeError("production server rejected without an Error");
  }
  throw new TypeError("production server unexpectedly resolved");
};

describe("production root client boundary", () => {
  for (const malformed of malformedCases) {
    test(`categorizes ${malformed.name} without leaking accessor text`, async () => {
      // Given one malformed value at the real exported plugin boundary.
      const fixture = malformed.make();

      // When production startup inspects that value.
      const error = await captureRejection(invokeProductionServer(fixture.input));

      // Then one frozen structured category replaces every raw failure and accessor runs once at most.
      expect({ name: error.name, code: Reflect.get(error, "code"), message: error.message }).toEqual({
        name: "PluginInputError",
        code: "client_unavailable",
        message: "",
      });
      expect(Object.isFrozen(error)).toBe(true);
      expect(fixture.accesses()).toBe(fixture.expectedAccesses);
    });
  }
});
