/**
 * Every environment setting the core reads, in one place.
 * Why: settings used to be read wherever they were needed, each with its own
 * default, so one module could fall back to a built-in secret while another
 * refused to start. Values are read on each call, not frozen at import, so a
 * test can change one and see the change.
 */

const LOCAL_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/kuru_database";
const LOCAL_PUBLIC_URL = "http://127.0.0.1:3000";
const MIN_SECRET_LENGTH = 32;

function read(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function list(name: string): string[] {
  return (read(name) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  isProduction: (): boolean => process.env.NODE_ENV === "production",
  isTest: (): boolean => process.env.NODE_ENV === "test",

  databaseUrl: (): string => read("DATABASE_URL") ?? LOCAL_DATABASE_URL,
  host: (): string => read("HOST") ?? "127.0.0.1",
  port: (): number => Number(read("PORT") ?? 3000),
  /**
   * Whose X-Forwarded-For header the core believes, as Express "trust proxy".
   * Why: a tunnel or reverse proxy on this machine connects from loopback and
   * names the real client in that header. Believing it only from loopback
   * gives each client its own request limit with nothing to configure, while
   * a client connecting directly cannot claim to be someone else.
   * TRUST_PROXY=1 trusts one proxy on another host; TRUST_PROXY=0 trusts none.
   */
  trustProxy: (): number | string | false => {
    const value = read("TRUST_PROXY");
    if (value === "0" || value === "false") return false;
    if (value && /^\d+$/.test(value)) return Number(value);
    return value ?? "loopback";
  },
  logLevel: (): string => read("LOG_LEVEL") ?? (config.isTest() ? "silent" : "info"),

  /** The public origin phones and OAuth providers reach the core on. */
  publicUrl: (): string => read("BETTER_AUTH_URL") ?? LOCAL_PUBLIC_URL,
  trustedOrigins: (): string[] => list("BETTER_AUTH_TRUSTED_ORIGINS"),

  /**
   * The secret that signs sessions and derives the vault key.
   * There is no built-in value: a core started without one stops here, in
   * every environment, so stored keys are never sealed with a public constant.
   */
  authSecret: (): string => {
    const secret = read("BETTER_AUTH_SECRET");
    if (!secret) {
      throw new Error("BETTER_AUTH_SECRET is required. Generate one with: openssl rand -hex 32");
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
    }
    return secret;
  },

  googleClientId: (): string | undefined => read("GOOGLE_CLIENT_ID"),
  googleClientSecret: (): string | undefined => read("GOOGLE_CLIENT_SECRET"),

  skillsDir: (): string | undefined => read("SKILLS_DIR"),
  dockerSocket: (): string => read("DOCKER_SOCKET") ?? "/var/run/docker.sock",
  /**
   * The Docker runtime account containers are created with, for example
   * "kata" on a Linux server. Unset uses Docker's default (runc), which is
   * what a Mac can run.
   */
  containerRuntime: (): string | undefined => read("CONTAINER_RUNTIME"),
  /**
   * How account containers are closed off from private addresses.
   * "netns": rules inside each container's network namespace (the default).
   * "host": rules on the host for one shared account network; the default
   * when CONTAINER_RUNTIME names a virtual-machine runtime, whose traffic
   * does not pass the namespace rules.
   * "off": no rules. Every agent can then reach this machine's database and
   * local network.
   */
  containerFirewall: (): "netns" | "host" | "off" => {
    const value = read("CONTAINER_FIREWALL")?.toLowerCase();
    if (value === "off" || value === "0" || value === "false") return "off";
    if (value === "host" || value === "netns") return value;
    const runtime = read("CONTAINER_RUNTIME");
    return runtime && runtime !== "runc" ? "host" : "netns";
  },
  /** Name servers for containers on the host-ruled account network, where Docker's own resolver is not reachable from a virtual machine. */
  containerDns: (): string[] => {
    const servers = list("CONTAINER_DNS");
    return servers.length > 0 ? servers : ["1.1.1.1", "8.8.8.8"];
  },

  braveApiKey: (): string | undefined => read("BRAVE_API_KEY"),
  exaApiKey: (): string | undefined => read("EXA_API_KEY"),
  embeddingProvider: (): string => read("EMBEDDING_PROVIDER") ?? "openai",
  embeddingModel: (): string | undefined => read("EMBEDDING_MODEL"),
  /**
   * Optional fixed model for every account's default agent, as "provider:modelId"
   * (for example "anthropic:claude-sonnet-5-5"). Unset, it uses the default model the person chooses during setup.
   */
  supportModel: (): { provider: string; modelId: string } | null => {
    const value = read("SUPPORT_AGENT_MODEL");
    const split = value?.indexOf(":") ?? -1;
    if (!value || split < 1 || split === value.length - 1) return null;
    return { provider: value.slice(0, split), modelId: value.slice(split + 1) };
  },
};
