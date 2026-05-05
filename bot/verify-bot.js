/**
 * DreamLand Verification Bot
 * 
 * Sends a verification embed with button when a user joins the server.
 * 
 * Setup:
 * 1. npm install discord.js
 * 2. Set BOT_TOKEN and GUILD_ID in .env
 * 3. node bot/verify-bot.js
 * 
 * Bot permissions needed:
 * - Send Messages
 * - Embed Links
 * - Manage Roles
 * - Read Message History
 */

require('dotenv').config({ path: '../.env' });

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// ── CONFIG ──────────────────────────────────────────────────────────────────
const GUILD_ID         = process.env.DISCORD_GUILD_ID;
const BOT_TOKEN        = process.env.DISCORD_BOT_TOKEN;
const VERIFY_CHANNEL   = process.env.VERIFY_CHANNEL_NAME  || 'verify';      // channel name to send embed
const VERIFIED_ROLE    = process.env.VERIFIED_ROLE_NAME   || 'Verified';    // role to assign after verify
const JOIN_URL         = process.env.JOIN_URL             || 'https://dreamland-gg-discord.vercel.app';
// ────────────────────────────────────────────────────────────────────────────

client.once('ready', () => {
  console.log(`✅ DreamLand Verification Bot is online as ${client.user.tag}`);
});

// ── SEND VERIFICATION EMBED WHEN MEMBER JOINS ────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  if (member.guild.id !== GUILD_ID) return;

  try {
    // Find the verification channel
    const channel = member.guild.channels.cache.find(
      ch => ch.name === VERIFY_CHANNEL && ch.isTextBased()
    );

    if (!channel) {
      console.warn(`⚠️  Verification channel "#${VERIFY_CHANNEL}" not found.`);
      return;
    }

    // Build the embed
    const embed = new EmbedBuilder()
      .setColor(0x8B5CF6)
      .setAuthor({
        name: '⚠️  Server Verification Required',
        iconURL: member.guild.iconURL({ dynamic: true }) ?? undefined,
      })
      .setTitle('Welcome to ✦ 𝕯𝖗𝖊𝖆𝖒𝕷𝖆𝖓𝖉 ࣪ ☾.࣪࿐')
      .setDescription(
        `Hey ${member}! 👋\n\n` +
        `To unlock all channels and features of **DreamLand**, you need to verify yourself first.\n\n` +
        `**What happens after verification?**\n` +
        `• ✅ Access to all server channels\n` +
        `• 💬 Ability to chat and participate\n` +
        `• 🎭 Access to all server features\n` +
        `• 🏅 **Verified** role assigned\n\n` +
        `*Click the button below to verify your identity.*`
      )
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
      .setImage(member.guild.bannerURL({ size: 1024 }) ?? null)
      .setFooter({
        text: `DreamLand Verification • ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
        iconURL: member.guild.iconURL({ dynamic: true }) ?? undefined,
      })
      .setTimestamp();

    // Build the verify button
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('⚠️  Verify to Unlock DreamLand')
        .setStyle(ButtonStyle.Link)
        .setURL(JOIN_URL)
        .setEmoji('🔓')
    );

    await channel.send({
      content: `${member} — Please verify to access **DreamLand**!`,
      embeds: [embed],
      components: [row],
    });

    console.log(`📨 Sent verification embed to ${member.user.tag}`);
  } catch (err) {
    console.error('❌ Failed to send verification embed:', err.message);
  }
});

// ── HANDLE BUTTON INTERACTION (if using non-link button) ─────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId !== 'verify_member') return;

  const member = interaction.member;
  const guild  = interaction.guild;

  try {
    // Find the verified role
    const role = guild.roles.cache.find(r => r.name === VERIFIED_ROLE);
    if (!role) {
      await interaction.reply({ content: '❌ Verified role not found. Contact an admin.', ephemeral: true });
      return;
    }

    // Assign the role
    await member.roles.add(role);

    await interaction.reply({
      content: `✅ You've been verified! Welcome to **DreamLand** 🎉 You now have access to all channels.`,
      ephemeral: true,
    });

    console.log(`✅ Verified ${member.user.tag}`);
  } catch (err) {
    console.error('❌ Failed to assign verified role:', err.message);
    await interaction.reply({ content: '❌ Something went wrong. Please contact an admin.', ephemeral: true });
  }
});

client.login(BOT_TOKEN);
