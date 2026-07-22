import { isAbsolute } from "node:path";
import { HarnessContractError } from "./errors";

export type HarnessDirectories = {
  readonly root: string;
  readonly home: string;
  readonly config: string;
  readonly data: string;
  readonly cache: string;
  readonly state: string;
  readonly tmp: string;
  readonly workspace: string;
  readonly database: string;
};

export type ChildEnvironmentInput = {
  readonly directories: HarnessDirectories;
  readonly configContent: string;
  readonly closedProxyPort: number;
  readonly disableDefaultPlugins: boolean;
};

const absoluteDirectories = (directories: HarnessDirectories): boolean => Object.values(directories).every(isAbsolute);

export const buildChildEnvironment = (input: ChildEnvironmentInput): Readonly<Record<string, string>> => {
  if (!absoluteDirectories(input.directories) || !Number.isSafeInteger(input.closedProxyPort)) {
    throw new HarnessContractError("environment");
  }
  if (input.closedProxyPort < 1 || input.closedProxyPort > 65_535) throw new HarnessContractError("environment");
  const proxy = `http://127.0.0.1:${String(input.closedProxyPort)}`;
  const base = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    HOME: input.directories.home,
    XDG_CONFIG_HOME: input.directories.config,
    XDG_DATA_HOME: input.directories.data,
    XDG_CACHE_HOME: input.directories.cache,
    XDG_STATE_HOME: input.directories.state,
    TMPDIR: input.directories.tmp,
    OPENCODE_CONFIG_CONTENT: input.configContent,
    OPENCODE_DB: input.directories.database,
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_AUTO_SHARE: "false",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
    OPENCODE_DISABLE_PRUNE: "1",
    OPENCODE_ENABLE_EXA: "false",
    OPENCODE_ENABLE_QUESTION_TOOL: "false",
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  } as const;
  return Object.freeze(input.disableDefaultPlugins
    ? { ...base, OPENCODE_DISABLE_DEFAULT_PLUGINS: "true" }
    : base);
};
