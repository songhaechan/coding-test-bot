import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import Holidays from 'date-holidays';
import { isHoliday as isHolidayKR } from '@hyunbinseo/holidays-kr';
import { Storage } from './storage.js';

const hd = new Holidays('KR');

// ===== Env =====
const TOKEN = process.env.DISCORD_TOKEN; // Bot token
const CLIENT_ID = process.env.DISCORD_CLIENT_ID; // Application ID
const GUILD_ID = process.env.GUILD_ID; // Guild (server) ID
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID; // Channel for screenshot posts
const PARTICIPANT_ROLE_ID = process.env.PARTICIPANT_ROLE_ID; // Role marking participants
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID; // Role allowed to run manual settle
const FINE_AMOUNT = Number(process.env.FINE_AMOUNT || '500');
const REPORT_CHANNEL_ID = process.env.FINE_REPORT_CHANNEL_ID || VERIFY_CHANNEL_ID; // Where to post daily results

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !VERIFY_CHANNEL_ID || !PARTICIPANT_ROLE_ID) {
  console.error('Missing required env. Please set DISCORD_TOKEN, DISCORD_CLIENT_ID, GUILD_ID, VERIFY_CHANNEL_ID, PARTICIPANT_ROLE_ID');
  process.exit(1);
}

// ===== Utils =====
function kstNowDate() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 9 * 3600000);
}

function formatDateYYYYMMDD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayKSTStr() {
  return formatDateYYYYMMDD(kstNowDate());
}

function yesterdayKSTStr() {
  const d = kstNowDate();
  d.setDate(d.getDate() - 1);
  return formatDateYYYYMMDD(d);
}

function isRestDay(d) {
  try {
    const dow = d.getDay(); // 0: Sun, 6: Sat
    const isWeekend = (dow === 0 || dow === 6);
    if (isWeekend) return true;

    // 1. Try specialized Korean holiday library (Very accurate for 2025-2026)
    try {
      return isHolidayKR(d);
    } catch (e) {
      // 2. Fallback to calculation-based library (Supports 2027+, though alternative holidays may vary)
      if (e instanceof RangeError) {
        const holidays = hd.isHoliday(d);
        return !!holidays;
      }
      throw e;
    }
  } catch (e) {
    console.warn(`[isRestDay] Error checking holiday for ${d}:`, e.message);
    return false; // Default to not skipping if check fails (safety)
  }
}

function yesterdayIsRestDayKST() {
  const d = kstNowDate();
  d.setDate(d.getDate() - 1);
  return isRestDay(d);
}

function scheduleDailyAtKSTMidnight(task) {
  const calcDelay = () => {
    const now = kstNowDate();
    const next = new Date(now);
    next.setHours(24, 0, 5, 0); // 00:00:05 next day KST
    return next.getTime() - now.getTime();
  };
  const scheduleNext = () => {
    const ms = calcDelay();
    setTimeout(async () => {
      try { await task(); } catch (e) { console.error('Midnight task error:', e); }
      scheduleNext();
    }, ms);
  };
  scheduleNext();
}

async function getParticipantIds(guild) {
  if (!PARTICIPANT_ROLE_ID) return [];
  const role = guild.roles.cache.get(PARTICIPANT_ROLE_ID) || await guild.roles.fetch(PARTICIPANT_ROLE_ID).catch(() => null);
  if (!role) return [];
  // role.members only returns cached members.
  // If cache is empty (e.g. after restart), fetch all members first.
  if (role.members.size === 0 && guild.memberCount > 0) {
    await guild.members.fetch();
  }
  return role.members
    .filter(m => !m.user.bot)
    .map(m => m.id);
}

async function syncParticipants(guild) {
  try {
    if (!PARTICIPANT_ROLE_ID) return;
    const role = guild.roles.cache.get(PARTICIPANT_ROLE_ID) || await guild.roles.fetch(PARTICIPANT_ROLE_ID).catch(() => null);
    if (!role) {
      console.warn(`[sync] Participant role (${PARTICIPANT_ROLE_ID}) not found in guild.`);
      return;
    }

    // Role members are only available if members are cached. 
    // ClientReady already fetches, but let's be sure.
    if (role.members.size === 0 && guild.memberCount > 0) {
      await guild.members.fetch();
    }
    
    const members = role.members.filter(m => !m.user.bot);
    console.log(`[sync] Syncing ${members.size} participants...`);
    
    let count = 0;
    for (const [id, member] of members) {
      await Storage.updateUser(id, member.user.username);
      count++;
    }
    console.log(`[sync] Successfully synced ${count} participants.`);
  } catch (e) {
    console.error('[sync] Failed to sync participants:', e);
  }
}

function isImageAttachment(att) {
  const ct = att.contentType || '';
  if (ct.startsWith('image/')) return true;
  const name = (att.name || '').toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].some(ext => name.endsWith(ext));
}

async function handleVerification(message) {
  if (message.channelId !== VERIFY_CHANNEL_ID) return;
  if (message.author.bot) return;

  const guild = message.guild;
  if (!guild) return;
  const member = await guild.members.fetch(message.author.id);
  if (!member.roles.cache.has(PARTICIPANT_ROLE_ID)) return; // Ignore non-participants

  const hasImage = message.attachments.some(isImageAttachment);
  if (!hasImage) return; // Only count messages with an image attachment as verification

  const dateStr = todayKSTStr();
  await Storage.updateUser(message.author.id, message.author.username);
  const already = await Storage.hasVerified(dateStr, message.author.id);
  if (!already) {
    await Storage.markVerified(dateStr, message.author.id);

    // Build remaining list only on first verification to avoid duplicate replies
    const all = await getParticipantIds(guild);
    const verified = await Storage.getVerified(dateStr);
    const remaining = all.filter(id => !verified.includes(id));

    const remainingPreview = remaining.slice(0, 20).map(id => `<@${id}>`).join(', ') || '없음';
    const more = remaining.length > 20 ? ` 외 ${remaining.length - 20}명` : '';
    await message.reply({
      content: `✅ <@${message.author.id}>\n\n코테 인증 완료! 🎉\n(${dateStr})\n\n오늘 벌금 예약 인원: ${remaining.length}명\n${remainingPreview}${more}`,
      allowedMentions: { users: remaining.slice(0, 20) }
    });
  } else {
    // Already verified today: avoid spamming replies; add a subtle reaction instead
    try { await message.react('✅'); } catch {}
  }
}

async function processFinesForDate(guild, dateStr, { force = false } = {}) {
  const last = await Storage.getLastProcessedDate();
  if (!force && last === dateStr) return { skipped: true };

  const participants = await getParticipantIds(guild);
  const verified = await Storage.getVerified(dateStr);
  const unverified = participants.filter(id => !verified.includes(id));

  for (const uid of unverified) {
    await Storage.addFine(uid, FINE_AMOUNT, dateStr);
  }
  await Storage.setLastProcessedDate(dateStr);

  return { skipped: false, unverified };
}

// ===== Client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, async () => {
  console.log(`[ready] Logged in as ${client.user.tag}`);

  // Pre-fetch guild members so that role.members cache is populated on restart
  try {
    const guild = await client.guilds.fetch(GUILD_ID).then(g => g.fetch());
    await guild.members.fetch();
    console.log(`[ready] Guild members cached: ${guild.members.cache.size}`);
    await syncParticipants(guild);
  } catch (e) {
    console.error('[ready] Failed to initial setup:', e);
  }

  // Schedule daily settlement for yesterday at KST midnight
  scheduleDailyAtKSTMidnight(async () => {
    try {
      // Skip if yesterday was a rest day (weekend or holiday KST)
      if (yesterdayIsRestDayKST()) {
        console.log('[settlement] Skipped due to weekend or holiday (KST)');
        return;
      }
      const guild = await client.guilds.fetch(GUILD_ID).then(g => g.fetch());
      const dateStr = yesterdayKSTStr();
      const { skipped, unverified } = await processFinesForDate(guild, dateStr);
      if (!skipped) {
        const ch = await client.channels.fetch(REPORT_CHANNEL_ID);
        if (ch && ch.isTextBased()) {
          const mentions = unverified.slice(0, 50).map(id => `<@${id}>`).join(', ') || '없음';
          await ch.send({
            content: `🧾 미인증 벌금 정산\n(${dateStr})\n\n대상: ${unverified.length}명\n${mentions}\n\n1인당 ${FINE_AMOUNT.toLocaleString()}원 부과되었습니다.`,
            allowedMentions: { users: unverified.slice(0, 50) }
          });
        }
      }
    } catch (e) {
      console.error('Daily settlement failed:', e);
    }
  });

  // Optional: register commands on boot (safe in dev; for prod use scripts/register-commands.js)
  try { await registerCommandsOnce(); } catch (e) { console.warn('Command registration skipped:', e.message); }
});

client.on(Events.MessageCreate, async (message) => {
  try { await handleVerification(message); } catch (e) { console.error('handleVerification error', e); }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;
  try {
    if (commandName === 'stats') {
      const dateStr = todayKSTStr();
      await Storage.updateUser(interaction.user.id, interaction.user.username);
      const fine = await Storage.getFine(interaction.user.id);
      const verified = await Storage.hasVerified(dateStr, interaction.user.id);
      await interaction.reply({
        content: `📊 내 인증/정산 현황\n\n오늘 인증: ${verified ? '완료 ✅' : '미완료 ❌'}\n누적 벌금: ${fine.total.toLocaleString()}원 (건수: ${fine.history.length})`,
        flags: MessageFlags.Ephemeral
      });
    } else if (commandName === 'ranking') {
      await Storage.updateUser(interaction.user.id, interaction.user.username);
      const rank = await Storage.getRanking(-1); // -1 for all users
      const lines = await Promise.all(rank.map(async (r, i) => {
        const name = r.username ? `**${r.username}**` : `<@${r.userId}>`;
        return `${i + 1}. ${name} — ${r.total.toLocaleString()}원`;
      }));
      await interaction.reply({ content: `🏆 전체 벌금 랭킹\n\n${lines.join('\n') || '없음'}` });
    } else if (commandName === 'myfine') {
      await Storage.updateUser(interaction.user.id, interaction.user.username);
      const fine = await Storage.getFine(interaction.user.id);
      await interaction.reply({
        content: `💰 내 누적 벌금: **${fine.total.toLocaleString()}원** (총 ${fine.history.length}건)`,
        flags: MessageFlags.Ephemeral
      });
    } else if (commandName === 'unverified') {
      await Storage.updateUser(interaction.user.id, interaction.user.username);
      const guild = await interaction.guild.fetch();
      const dateStr = todayKSTStr();
      const participants = await getParticipantIds(guild);
      const verified = await Storage.getVerified(dateStr);
      const unv = participants.filter(id => !verified.includes(id));
      const mentions = unv.slice(0, 50).map(id => `<@${id}>`).join(', ') || '없음';
      await interaction.reply({ content: `⚠️ 오늘 미인증 현황\n(${dateStr})\n\n대상: ${unv.length}명\n${mentions}` });
    } else if (commandName === 'settle') {
      await Storage.updateUser(interaction.user.id, interaction.user.username);
      // Permission check
      const isAdmin = ADMIN_ROLE_ID ? interaction.member.roles.cache.has(ADMIN_ROLE_ID) : interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
      if (!isAdmin) {
        return interaction.reply({ content: '권한이 없습니다.', flags: MessageFlags.Ephemeral });
      }
      const dateStr = interaction.options.getString('date') || yesterdayKSTStr();
      const force = interaction.options.getBoolean('force') || false;
      const guild = await interaction.guild.fetch();
      const { skipped, unverified } = await processFinesForDate(guild, dateStr, { force });
      if (skipped) return interaction.reply({ content: `이미 정산된 날짜입니다.\n(${dateStr})\n\nforce 옵션으로 재정산 가능합니다.`, flags: MessageFlags.Ephemeral });
      await interaction.reply({ content: `🧾 수동 정산 완료\n(${dateStr})\n\n미인증: ${unverified.length}명\n1인당: ${FINE_AMOUNT.toLocaleString()}원` });
    } else if (commandName === 'join') {
      await Storage.updateUser(interaction.user.id, interaction.user.username);
      if (!PARTICIPANT_ROLE_ID) return interaction.reply({ content: '참여자 역할 ID가 설정되지 않았습니다.', flags: MessageFlags.Ephemeral });
      
      // Use deferReply to avoid 3s timeout issue
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (member.roles.cache.has(PARTICIPANT_ROLE_ID)) {
        return interaction.editReply({ content: '이미 참여자 역할이 있습니다.' });
      }
      try {
        await member.roles.add(PARTICIPANT_ROLE_ID, 'Self-join via /join');
        await interaction.editReply({ content: '참여자 역할이 부여되었습니다. 환영합니다! 🎉' });
      } catch (e) {
        console.error('Failed to add role on /join:', e);
        // Double check if role was actually added despite the error
        await member.fetch(true);
        if (member.roles.cache.has(PARTICIPANT_ROLE_ID)) {
          return interaction.editReply({ content: '참여자 역할이 부여되었습니다. 환영합니다! 🎉' });
        }
        await interaction.editReply({ content: '역할을 부여하지 못했습니다. 봇 권한(Manage Roles)과 역할 순서를 확인해주세요.' });
      }
    }
  } catch (e) {
    console.error('Command error:', e);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: '오류가 발생했습니다.', flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: '오류가 발생했습니다.', flags: MessageFlags.Ephemeral });
    }
  }
});

// Auto-assign participant role to new members
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (!PARTICIPANT_ROLE_ID) return;
    if (member.user.bot) return;
    if (member.guild.id !== GUILD_ID) return;
    if (member.roles.cache.has(PARTICIPANT_ROLE_ID)) return;
    await member.roles.add(PARTICIPANT_ROLE_ID, 'Auto-assign on join');
    await Storage.updateUser(member.id, member.user.username);
  } catch (e) {
    console.error('Failed to auto-assign role on join:', e);
  }
});

// Register commands programmatically (guild scoped)
async function registerCommandsOnce() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const commands = [
    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('View your status and fines')
      .setNameLocalizations({ ko: '정산' })
      .setDescriptionLocalizations({ ko: '내 인증/정산 현황 보기' }),
    new SlashCommandBuilder()
      .setName('ranking')
      .setDescription('View fines ranking')
      .setNameLocalizations({ ko: '랭킹' })
      .setDescriptionLocalizations({ ko: '벌금 랭킹 보기' }),
    new SlashCommandBuilder()
      .setName('unverified')
      .setDescription("List today's unverified participants")
      .setNameLocalizations({ ko: '미인증' })
      .setDescriptionLocalizations({ ko: '오늘 미인증자 보기' }),
    new SlashCommandBuilder()
      .setName('settle')
      .setDescription('Settle fines for a date (admin)')
      .setNameLocalizations({ ko: '수동정산' })
      .setDescriptionLocalizations({ ko: '특정 날짜 수동 정산 (관리자)' })
      .addStringOption(o => o.setName('date').setDescription('YYYY-MM-DD (KST)').setRequired(false))
      .addBooleanOption(o => o.setName('force').setDescription('Force re-settle even if already done').setRequired(false)),
    new SlashCommandBuilder()
      .setName('join')
      .setDescription('Give yourself the participant role')
      .setNameLocalizations({ ko: '참여' })
      .setDescriptionLocalizations({ ko: '참여자 역할 받기' }),
    new SlashCommandBuilder()
      .setName('myfine')
      .setDescription('Check your cumulative fines')
      .setNameLocalizations({ ko: '내벌금' })
      .setDescriptionLocalizations({ ko: '내 누적 벌금 확인하기' })
  ].map(c => c.toJSON());

  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('Slash commands registered (guild).');
}

client.login(TOKEN);
