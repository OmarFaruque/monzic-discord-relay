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

const botToken = requireEnv("DISCORD_BOT_TOKEN");
const relayApiKey = requireEnv("DISCORD_RELAY_API_KEY");
const relayBaseUrl = requireEnv("DISCORD_RELAY_BASE_URL");
const ticketCategoryId = requireEnv("DISCORD_TICKET_CATEGORY_ID");
const supportRoleId = process.env.DISCORD_SUPPORT_ROLE_ID;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

function shouldRelayMessage(message: Message): boolean {
  if (message.author.bot || !message.guild) return false;
  if (message.channel.type !== ChannelType.GuildText) return false;
  if (message.channel.parentId !== ticketCategoryId) return false;

  if (supportRoleId) {
    return message.member?.roles.cache.has(supportRoleId) ?? false;
  }

  return true;
}

async function relayToApp(message: Message): Promise<void> {
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
    const body = await response.text();
    throw new Error(`Relay failed (${response.status}): ${body}`);
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[discord-relay] Ready as ${readyClient.user.tag}`);
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