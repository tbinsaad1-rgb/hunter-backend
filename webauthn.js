const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

// ── إعدادات من متغيرات البيئة (لازم تطابق الدومين اللي عليه agent.html) ──
const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'Hunter';
const RP_ID   = process.env.WEBAUTHN_RP_ID   || 'localhost';
const ORIGIN  = process.env.WEBAUTHN_ORIGIN  || 'http://localhost:5173';

// تحديات مؤقتة بالذاكرة (تنتهي خلال دقيقتين)
const pendingChallenges = new Map(); // key -> { challenge, userId?, expiresAt }
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingChallenges.entries()) {
    if (now > val.expiresAt) pendingChallenges.delete(key);
  }
}, 60 * 1000);
cleanupInterval.unref();

function randomKey() {
  return require('crypto').randomBytes(16).toString('hex');
}

// ── خطوة 1: توليد خيارات تسجيل بصمة جديدة لمستخدم مسجّل دخوله بالفعل ──
async function getRegistrationOptions(user, existingCredentials) {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: Buffer.from(String(user.id)),
    userName: user.username,
    userDisplayName: user.full_name || user.username,
    attestationType: 'none',
    excludeCredentials: existingCredentials.map(c => ({ id: c.credential_id })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
      authenticatorAttachment: 'platform', // بصمة/وجه الجهاز نفسه، مو مفتاح خارجي
    },
  });
  const key = randomKey();
  pendingChallenges.set(key, { challenge: options.challenge, userId: user.id, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return { options, challengeKey: key };
}

// ── خطوة 2: التحقق من نتيجة التسجيل وحفظ بيانات البصمة ──
async function verifyRegistration(challengeKey, response) {
  const pending = pendingChallenges.get(challengeKey);
  if (!pending) throw new Error('انتهت صلاحية الطلب، حاول من جديد');
  pendingChallenges.delete(challengeKey);

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('فشل التحقق من البصمة');
  }
  const { credential } = verification.registrationInfo;
  return {
    userId: pending.userId,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64'),
    counter: credential.counter,
  };
}

// ── خطوة 1 لتسجيل الدخول: توليد تحدي مصادقة لمستخدم معيّن ──
async function getAuthenticationOptions(username, credentials) {
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'preferred',
    allowCredentials: credentials.map(c => ({ id: c.credential_id })),
  });
  const key = randomKey();
  pendingChallenges.set(key, { challenge: options.challenge, username, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return { options, challengeKey: key };
}

// ── خطوة 2 لتسجيل الدخول: التحقق من المصادقة ضد البصمة المخزّنة ──
async function verifyAuthentication(challengeKey, response, storedCredential) {
  const pending = pendingChallenges.get(challengeKey);
  if (!pending) throw new Error('انتهت صلاحية الطلب، حاول من جديد');
  pendingChallenges.delete(challengeKey);

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: pending.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: storedCredential.credential_id,
      publicKey: Buffer.from(storedCredential.public_key, 'base64'),
      counter: storedCredential.counter,
    },
  });
  if (!verification.verified) throw new Error('فشل التحقق من البصمة');
  return { newCounter: verification.authenticationInfo.newCounter };
}

module.exports = {
  getRegistrationOptions,
  verifyRegistration,
  getAuthenticationOptions,
  verifyAuthentication,
  RP_ID,
  ORIGIN,
};
