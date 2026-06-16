const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const INVITE_STATUS = {
  UNUSED: 'unused',
  USED: 'used',
  EXPIRED: 'expired',
  REVOKED: 'revoked'
};

const inviteLinkSchema = new mongoose.Schema({
  id: {
    type: String,
    default: uuidv4,
    unique: true
  },
  surveyId: {
    type: String,
    required: true,
    index: true
  },
  code: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  status: {
    type: String,
    enum: Object.values(INVITE_STATUS),
    default: INVITE_STATUS.UNUSED,
    index: true
  },
  maxUses: {
    type: Number,
    default: 1
  },
  currentUses: {
    type: Number,
    default: 0
  },
  expiresAt: {
    type: Date,
    default: null,
    index: true
  },
  usedAt: {
    type: Date,
    default: null
  },
  usedBy: {
    userId: { type: String, default: null },
    ipAddress: { type: String, default: null },
    deviceId: { type: String, default: null }
  },
  createdBy: {
    type: String,
    required: true
  },
  note: {
    type: String,
    default: null,
    maxlength: 200
  },
  responseId: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

inviteLinkSchema.index({ surveyId: 1, status: 1 });
inviteLinkSchema.index({ code: 1, status: 1 });

inviteLinkSchema.methods.isUsable = function() {
  if (this.status === INVITE_STATUS.REVOKED) {
    return { usable: false, reason: '邀请链接已作废' };
  }
  
  if (this.status === INVITE_STATUS.USED && this.currentUses >= this.maxUses) {
    return { usable: false, reason: '邀请链接已使用过' };
  }
  
  if (this.expiresAt && new Date() > new Date(this.expiresAt)) {
    return { usable: false, reason: '邀请链接已过期' };
  }
  
  return { usable: true };
};

inviteLinkSchema.statics.claimByCode = async function(code, respondent = {}, responseId = null) {
  if (!code) {
    return { success: false, reason: '缺少邀请码' };
  }

  const normalizedCode = String(code).toUpperCase();
  const now = new Date();

  const result = await this.findOneAndUpdate(
    {
      code: normalizedCode,
      status: INVITE_STATUS.UNUSED,
      $expr: { $lt: ['$currentUses', '$maxUses'] },
      $or: [
        { expiresAt: null },
        { expiresAt: { $gt: now } }
      ]
    },
    {
      $inc: { currentUses: 1 },
      $set: {
        usedAt: now,
        'usedBy.userId': respondent.userId || null,
        'usedBy.ipAddress': respondent.ipAddress || null,
        'usedBy.deviceId': respondent.deviceId || null,
        ...(responseId ? { responseId } : {})
      }
    },
    { new: true }
  );

  if (result) {
    if (result.currentUses >= result.maxUses) {
      await this.updateOne({ _id: result._id }, { $set: { status: INVITE_STATUS.USED } });
      result.status = INVITE_STATUS.USED;
    }
    return { success: true, invite: result };
  }

  const existing = await this.getByCode(normalizedCode);
  if (!existing) {
    return { success: false, reason: '邀请码无效' };
  }

  const usability = existing.isUsable();
  return { success: false, reason: usability.reason, invite: existing };
};

inviteLinkSchema.methods.markUsed = async function(respondent, responseId) {
  this.currentUses += 1;
  this.usedAt = new Date();
  this.usedBy = {
    userId: respondent.userId || null,
    ipAddress: respondent.ipAddress || null,
    deviceId: respondent.deviceId || null
  };
  this.responseId = responseId || this.responseId;
  
  if (this.currentUses >= this.maxUses) {
    this.status = INVITE_STATUS.USED;
  }
  
  return this.save();
};

inviteLinkSchema.statics.generateCode = function(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const randomBytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    code += chars[randomBytes[i] % chars.length];
  }
  return code;
};

inviteLinkSchema.statics.batchCreate = async function(surveyId, createdBy, count = 10, options = {}) {
  const { maxUses = 1, expiresAt = null, note = null } = options;
  
  const links = [];
  const usedCodes = new Set();
  
  for (let i = 0; i < count; i++) {
    let code;
    do {
      code = this.generateCode(10);
    } while (usedCodes.has(code));
    
    usedCodes.add(code);
    
    links.push({
      surveyId,
      code,
      maxUses,
      expiresAt,
      createdBy,
      note: note || null,
      status: INVITE_STATUS.UNUSED,
      currentUses: 0
    });
  }
  
  const result = await this.insertMany(links);
  return result;
};

inviteLinkSchema.statics.getByCode = function(code) {
  return this.findOne({ code: code?.toUpperCase() });
};

inviteLinkSchema.statics.getSurveyInvites = async function(surveyId, options = {}) {
  const { status = null, page = 1, limit = 50 } = options;
  
  const query = { surveyId };
  if (status) {
    query.status = status;
  }
  
  const [invites, total] = await Promise.all([
    this.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit))
      .lean(),
    this.countDocuments(query)
  ]);
  
  return {
    invites,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit))
    }
  };
};

inviteLinkSchema.statics.getStatsBySurvey = async function(surveyId) {
  const [all, used, expired, revoked] = await Promise.all([
    this.countDocuments({ surveyId }),
    this.countDocuments({ surveyId, status: INVITE_STATUS.USED }),
    this.countDocuments({ surveyId, status: INVITE_STATUS.EXPIRED }),
    this.countDocuments({ surveyId, status: INVITE_STATUS.REVOKED })
  ]);
  
  return {
    total: all,
    unused: all - used - expired - revoked,
    used,
    expired,
    revoked
  };
};

const InviteLink = mongoose.model('InviteLink', inviteLinkSchema);

module.exports = {
  InviteLink,
  INVITE_STATUS
};
