import "dotenv/config";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}


type RelayRoute = {
  categoryId: string;
  baseUrl: string;
};

function parseRelayRoutes(): RelayRoute[] {
  const routesRaw = process.env.DISCORD_RELAY_ROUTES;
  if (routesRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(routesRaw);
    } catch {
      throw new Error(
        "Invalid DISCORD_RELAY_ROUTES format. Expected JSON array, e.g. [{\"categoryId\":\"...\",\"baseUrl\":\"https://site\"}]",
      );
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("DISCORD_RELAY_ROUTES must be a non-empty JSON array.");
    }

    return parsed.map((item, index) => {
      if (!item || typeof item !== "object") {
        throw new Error(`DISCORD_RELAY_ROUTES[${index}] must be an object.`);
      }

      const categoryId = (item as { categoryId?: unknown }).categoryId;
      const baseUrl = (item as { baseUrl?: unknown }).baseUrl;

      if (typeof categoryId !== "string" || !categoryId.trim()) {
        throw new Error(`DISCORD_RELAY_ROUTES[${index}].categoryId must be a non-empty string.`);
      }

      if (typeof baseUrl !== "string" || !baseUrl.trim()) {
        throw new Error(`DISCORD_RELAY_ROUTES[${index}].baseUrl must be a non-empty string.`);
      }

      return {
        categoryId: categoryId.trim(),
        baseUrl: baseUrl.trim(),
      };
    });
  }

  const legacyCategoryId = requireEnv("DISCORD_TICKET_CATEGORY_ID");
  const legacyBaseUrl = requireEnv("DISCORD_RELAY_BASE_URL");

  return [{
    categoryId: legacyCategoryId,
    baseUrl: legacyBaseUrl,
  }];
}

const botToken = requireEnv("DISCORD_BOT_TOKEN");
const relayApiKey = requireEnv("DISCORD_RELAY_API_KEY");
const supportRoleId = process.env.DISCORD_SUPPORT_ROLE_ID;

const relayRoutes = parseRelayRoutes();
const relayRouteMap = new Map(relayRoutes.map((route) => [route.categoryId, route.baseUrl]));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});


function getRelayBaseUrl(message: Message): string | null {
  if (message.channel.type !== ChannelType.GuildText) return null;
  const parentCategoryId = message.channel.parentId;
  if (!parentCategoryId) return null;

  return relayRouteMap.get(parentCategoryId) ?? null;
}

function shouldRelayMessage(message: Message): boolean {
  if (message.author.bot || !message.guild) return false;
  if (message.channel.type !== ChannelType.GuildText) return false;
  if (!getRelayBaseUrl(message)) return false;

  if (supportRoleId) {
    return message.member?.roles.cache.has(supportRoleId) ?? false;
  }

  return true;
}

async function relayToApp(message: Message): Promise<void> {
  const relayBaseUrl = getRelayBaseUrl(message);
  if (!relayBaseUrl) return;

  const content = message.content.trim();
  const attachments = [...message.attachments.values()].map((attachment) => attachment.url);

  if (!content && attachments.length === 0) return;

  const response = await fetch(`${relayBaseUrl.replace(/\/$/, "")}/api/discord/tickets/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-discord-relay-key": relayApiKey,
    },
    body: JSON.stringify({
      channelId: message.channel.id,
      message: content || "(attachment only)",
      attachments,
    }),
  });

  if (!response.ok) {
    console.error(`[discord-relay] Relay error (${response.status}):`, await response.text());
    const body = await response.text();
    throw new Error(`Relay failed (${response.status}): ${body}`);
  }else{
    console.log(`[discord-relay] Successfully relayed message ${message.id} from channel ${message.channel.id}`);
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[discord-relay] Ready as ${readyClient.user.tag}`);
  console.log(`[discord-relay] Loaded ${relayRouteMap.size} relay route(s).`);
});

client.on(Events.MessageCreate, async (message) => {
  if (!shouldRelayMessage(message)) return;

  try {
    await relayToApp(message);
  } catch (error) {
    console.error("[discord-relay] Failed to relay message:", error);
  }
});

client.login(botToken).catch((error) => {
  console.error("[discord-relay] Failed to login:", error);
  process.exit(1);
});