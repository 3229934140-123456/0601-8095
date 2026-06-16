const mongoose = require('mongoose');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const answerSchema = new mongoose.Schema({
  questionId: {
    type: String,
    required: true
  },
  value: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  questionType: {
    type: String,
    required: true
  }
}, { _id: false });

const antiDuplicateKeySchema = new mongoose.Schema({
  mode: {
    type: String,
    required: true
  },
  key: {
    type: String,
    required: true
  }
}, { _id: false });

const responseSchema = new mongoose.Schema({
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
  surveyVersion: {
    type: Number,
    required: true
  },
  answers: {
    type: [answerSchema],
    required: true
  },
  respondent: {
    userId: { type: String, default: null, index: true },
    ipAddress: { type: String, required: true },
    deviceId: { type: String, default: null, index: true },
    userAgent: { type: String, default: null },
    fingerprint: { type: String, default: null, index: true }
  },
  antiDuplicateKeys: {
    type: [antiDuplicateKeySchema],
    default: []
  },
  metadata: {
    startTime: { type: Date },
    endTime: { type: Date },
    completionTime: { type: Number }
  },
  quality: {
    riskLevel: { type: String, enum: ['low', 'medium', 'high'], default: 'low', index: true },
    riskFlags: { type: [String], default: [] },
    completionSeconds: { type: Number, default: null },
    answerConsistency: { type: Number, default: null }
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
});

responseSchema.index({ surveyId: 1, 'respondent.userId': 1 }, { sparse: true });
responseSchema.index({ surveyId: 1, 'respondent.ipAddress': 1 });
responseSchema.index({ surveyId: 1, 'respondent.deviceId': 1 }, { sparse: true });
responseSchema.index({ surveyId: 1, 'respondent.fingerprint': 1 }, { sparse: true });
responseSchema.index({ createdAt: -1 });

responseSchema.index(
  { 'antiDuplicateKeys.mode': 1, 'antiDuplicateKeys.key': 1 },
  { unique: true, sparse: true, name: 'anti_duplicate_unique' }
);

responseSchema.pre('save', function(next) {
  if (!this.quality) {
    this.quality = { riskLevel: 'low', riskFlags: [], completionSeconds: null, answerConsistency: null };
  }
  
  const existingFlags = this.quality.riskFlags || [];
  const flags = new Set(existingFlags.filter(f => 
    f !== 'duplicate_ip' && f !== 'duplicate_device' && f !== 'high_frequency_submit'
  ));
  let score = 0;
  const questionCount = this.answers?.length || 0;
  
  let completionSeconds = null;
  if (this.metadata?.completionTime !== undefined && this.metadata.completionTime !== null) {
    completionSeconds = Number(this.metadata.completionTime) || 0;
    this.quality.completionSeconds = completionSeconds;
    
    if (completionSeconds > 0) {
      if (questionCount > 0) {
        const perQuestionSeconds = completionSeconds / questionCount;
        if (perQuestionSeconds < 2) {
          flags.add('too_fast');
          score += 30;
        } else if (perQuestionSeconds < 5) {
          flags.add('suspiciously_fast');
          score += 10;
        }
      }
      
      if (completionSeconds < 5) {
        flags.add('instant_submit');
        score += 20;
      }
    }
    
    if (completionSeconds > 3600) {
      flags.add('too_slow');
      score += 5;
    }
  }
  
  if (this.answers && questionCount > 0) {
    let sameAnswerCount = 0;
    const textAnswerValues = [];
    
    for (const ans of this.answers) {
      if (ans.questionType === 'SINGLE_CHOICE' || ans.questionType === 'MULTIPLE_CHOICE') {
        if (Array.isArray(ans.value)) {
          if (ans.value.length === 1 && ans.value[0] === 'a') sameAnswerCount++;
        } else if (ans.value === 'a' || ans.value === 1) {
          sameAnswerCount++;
        }
      }
      if (ans.questionType === 'TEXT' && typeof ans.value === 'string') {
        textAnswerValues.push(ans.value);
      }
    }
    
    const choiceCount = this.answers.filter(a => 
      a.questionType === 'SINGLE_CHOICE' || a.questionType === 'MULTIPLE_CHOICE'
    ).length;
    if (choiceCount > 3 && sameAnswerCount / choiceCount > 0.8) {
      flags.add('straight_lining');
      score += 25;
    }
    
    if (textAnswerValues.length >= 2) {
      const uniqueTexts = new Set(textAnswerValues.map(t => t.trim().toLowerCase()));
      if (uniqueTexts.size === 1 && textAnswerValues[0].trim().length > 0) {
        flags.add('duplicate_text_answers');
        score += 15;
      }
    }
  }
  
  if (this.answers && this.answers.length > 0) {
    const skippedCount = this.answers.filter(a => 
      a.value === '' || a.value === null || a.value === undefined ||
      (Array.isArray(a.value) && a.value.length === 0)
    ).length;
    if (skippedCount / this.answers.length > 0.5) {
      flags.add('many_skipped');
      score += 10;
    }
  }
  
  this.quality.riskFlags = [...flags];
  this.quality.riskLevel = this._deriveRiskLevel(score);
  this.quality._baseScore = score;
  
  next();
});

responseSchema.methods._deriveRiskLevel = function(score) {
  if (score >= 40) return 'high';
  if (score >= 15) return 'medium';
  return 'low';
};

responseSchema.methods.applyCrossResponseFlags = function(crossFlags, extraScore = 0) {
  const currentFlags = new Set(this.quality?.riskFlags || []);
  for (const f of crossFlags) {
    currentFlags.add(f);
  }
  this.quality = this.quality || {};
  this.quality.riskFlags = [...currentFlags];
  const base = (this.quality._baseScore !== undefined) ? this.quality._baseScore : 0;
  this.quality.riskLevel = this._deriveRiskLevel(base + extraScore);
  return this;
};

responseSchema.statics.scanAndMarkCrossResponseQuality = async function(surveyId, options = {}) {
  const {
    duplicateIpThreshold = 1,
    duplicateDeviceThreshold = 1,
    highFrequencyWindowMs = 5 * 60 * 1000,
    highFrequencyThreshold = 3
  } = options;

  const allResponses = await this.find({ surveyId }).sort({ createdAt: 1 }).lean();
  if (allResponses.length === 0) {
    return { updated: 0, flaggedIps: 0, flaggedDevices: 0, highFrequencyGroups: 0 };
  }

  const byIp = new Map();
  const byDevice = new Map();
  for (const r of allResponses) {
    const ip = r.respondent?.ipAddress;
    const dev = r.respondent?.deviceId;
    if (ip) {
      if (!byIp.has(ip)) byIp.set(ip, []);
      byIp.get(ip).push(r);
    }
    if (dev) {
      if (!byDevice.has(dev)) byDevice.set(dev, []);
      byDevice.get(dev).push(r);
    }
  }

  const responseIdToFlags = new Map();
  const addFlag = (rid, flag, weight) => {
    if (!responseIdToFlags.has(rid)) responseIdToFlags.set(rid, { flags: new Set(), score: 0 });
    responseIdToFlags.get(rid).flags.add(flag);
    responseIdToFlags.get(rid).score += weight;
  };

  let flaggedIps = 0, flaggedDevices = 0;

  for (const [ip, list] of byIp.entries()) {
    if (list.length > duplicateIpThreshold) {
      flaggedIps++;
      for (const r of list) addFlag(r.id, 'duplicate_ip', 15);
    }
  }

  for (const [dev, list] of byDevice.entries()) {
    if (list.length > duplicateDeviceThreshold) {
      flaggedDevices++;
      for (const r of list) addFlag(r.id, 'duplicate_device', 20);
    }
  }

  let highFrequencyGroups = 0;
  const allTimed = allResponses
    .filter(r => r.respondent?.ipAddress || r.respondent?.deviceId)
    .map(r => ({
      id: r.id,
      ts: new Date(r.createdAt).getTime(),
      key: r.respondent?.deviceId || r.respondent?.ipAddress
    }));

  const byKey = new Map();
  for (const t of allTimed) {
    if (!byKey.has(t.key)) byKey.set(t.key, []);
    byKey.get(t.key).push(t);
  }

  for (const arr of byKey.values()) {
    arr.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < arr.length; i++) {
      let j = i;
      const windowItems = [];
      while (j < arr.length && arr[j].ts - arr[i].ts <= highFrequencyWindowMs) {
        windowItems.push(arr[j]);
        j++;
      }
      if (windowItems.length >= highFrequencyThreshold) {
        highFrequencyGroups++;
        for (const t of windowItems) {
          addFlag(t.id, 'high_frequency_submit', 25);
        }
        break;
      }
    }
  }

  let updated = 0;
  for (const [rid, info] of responseIdToFlags.entries()) {
    const doc = await this.findOne({ id: rid });
    if (!doc) continue;
    doc.applyCrossResponseFlags([...info.flags], info.score);
    await doc.save();
    updated++;
  }

  return { updated, flaggedIps, flaggedDevices, highFrequencyGroups };
};

responseSchema.statics.analyzeResponsesQuality = async function(surveyId, filters = {}) {
  const query = this.buildFilterQuery(surveyId, filters);
  const responses = await this.find(query).lean();
  
  const stats = {
    total: responses.length,
    byRiskLevel: { low: 0, medium: 0, high: 0 },
    byFlag: {},
    avgCompletionSeconds: null,
    medianCompletionSeconds: null
  };
  
  const completionTimes = [];
  
  for (const r of responses) {
    const level = r.quality?.riskLevel || 'low';
    stats.byRiskLevel[level] = (stats.byRiskLevel[level] || 0) + 1;
    
    const flags = r.quality?.riskFlags || [];
    for (const flag of flags) {
      stats.byFlag[flag] = (stats.byFlag[flag] || 0) + 1;
    }
    
    if (r.quality?.completionSeconds !== null && r.quality?.completionSeconds !== undefined) {
      completionTimes.push(r.quality.completionSeconds);
    }
  }
  
  if (completionTimes.length > 0) {
    completionTimes.sort((a, b) => a - b);
    stats.avgCompletionSeconds = Math.round(completionTimes.reduce((s, t) => s + t, 0) / completionTimes.length);
    const mid = Math.floor(completionTimes.length / 2);
    stats.medianCompletionSeconds = completionTimes.length % 2 === 0
      ? Math.round((completionTimes[mid - 1] + completionTimes[mid]) / 2)
      : completionTimes[mid];
  }
  
  const duplicateSourceAnalysis = await this.aggregate([
    { $match: { surveyId } },
    { $group: {
      _id: '$respondent.ipAddress',
      count: { $sum: 1 },
      responseIds: { $push: '$id' }
    }},
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 20 }
  ]);
  
  return {
    stats,
    duplicateSources: {
      byIp: duplicateSourceAnalysis,
      totalDuplicateIps: duplicateSourceAnalysis.length
    },
    topRiskFlags: Object.entries(stats.byFlag)
      .sort((a, b) => b[1] - a[1])
      .map(([flag, count]) => ({ flag, count }))
  };
};

responseSchema.statics.generateAntiDuplicateKeys = function(surveyId, respondent, mode, expiryHours = 24) {
  const keys = [];
  const expiryBucket = Math.floor(Date.now() / (expiryHours * 3600 * 1000));
  
  const makeKey = (...parts) => {
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  };
  
  const addKeyIfPresent = (keyMode, ...keyParts) => {
    if (keyParts.every(p => p !== null && p !== undefined && String(p).trim() !== '')) {
      const key = makeKey(keyMode, surveyId, String(expiryBucket), ...keyParts);
      if (!keys.some(k => k.mode === keyMode && k.key === key)) {
        keys.push({ mode: keyMode, key });
      }
    }
  };
  
  switch (mode) {
    case 'by_user':
      addKeyIfPresent('by_user', respondent.userId);
      addKeyIfPresent('by_ip', respondent.ipAddress);
      if (respondent.deviceId || respondent.fingerprint) {
        addKeyIfPresent('by_device_fp', respondent.deviceId || '', respondent.fingerprint || '');
      }
      break;
      
    case 'by_ip':
      addKeyIfPresent('by_ip', respondent.ipAddress);
      if (respondent.deviceId) {
        addKeyIfPresent('by_device', respondent.deviceId);
      }
      if (respondent.fingerprint) {
        addKeyIfPresent('by_fp', respondent.fingerprint);
      }
      break;
      
    case 'by_device':
      addKeyIfPresent('by_device', respondent.deviceId);
      addKeyIfPresent('by_fp', respondent.fingerprint);
      if (!respondent.deviceId && !respondent.fingerprint) {
        addKeyIfPresent('by_ip', respondent.ipAddress);
      } else if (!respondent.deviceId || !respondent.fingerprint) {
        addKeyIfPresent('by_ip', respondent.ipAddress);
      }
      break;
      
    case 'by_user_ip_device':
      addKeyIfPresent('by_user', respondent.userId);
      addKeyIfPresent('by_ip', respondent.ipAddress);
      addKeyIfPresent('by_device', respondent.deviceId);
      addKeyIfPresent('by_fp', respondent.fingerprint);
      if (respondent.userId && respondent.ipAddress) {
        addKeyIfPresent('by_user_ip', respondent.userId, respondent.ipAddress);
      }
      if (respondent.userId && (respondent.deviceId || respondent.fingerprint)) {
        addKeyIfPresent('by_user_device', respondent.userId, respondent.deviceId || '', respondent.fingerprint || '');
      }
      break;
      
    case 'none':
    default:
      break;
  }
  
  return keys;
};

responseSchema.statics.checkDuplicate = async function(surveyId, respondent, mode, expiryHours = 24) {
  const antiDuplicateKeys = this.generateAntiDuplicateKeys(surveyId, respondent, mode, expiryHours);
  
  if (antiDuplicateKeys.length === 0) {
    return { isDuplicate: false, reason: 'no_anti_duplicate_keys' };
  }
  
  const duplicateQuery = antiDuplicateKeys.map(k => ({ 
    'antiDuplicateKeys': { $elemMatch: { mode: k.mode, key: k.key } } 
  }));
  
  const existing = await this.findOne({
    surveyId,
    $or: duplicateQuery
  }).select('id createdAt').lean();
  
  if (existing) {
    return {
      isDuplicate: true,
      existingId: existing.id,
      existingAt: existing.createdAt,
      mode
    };
  }
  
  return { isDuplicate: false };
};

responseSchema.methods.getAnswerByQuestionId = function(questionId) {
  return this.answers.find(a => a.questionId === questionId);
};

responseSchema.statics.getResponsesBySurveyVersion = function(surveyId, version = null) {
  const query = { surveyId };
  if (version !== null) {
    query.surveyVersion = version;
  }
  return this.find(query).sort({ createdAt: -1 });
};

responseSchema.statics.getResponseCountByVersion = async function(surveyId) {
  return this.aggregate([
    { $match: { surveyId } },
    { $group: {
      _id: '$surveyVersion',
      count: { $sum: 1 }
    }},
    { $sort: { _id: 1 } }
  ]);
};

responseSchema.statics.createWithAntiDuplicate = async function(responseData, surveyId, respondent, mode, expiryHours) {
  const antiDuplicateKeys = this.generateAntiDuplicateKeys(surveyId, respondent, mode, expiryHours);
  
  responseData.antiDuplicateKeys = antiDuplicateKeys;
  
  const saved = new this(responseData);
  
  try {
    const session = await this.startSession();
    
    try {
      await session.withTransaction(async () => {
        await saved.save({ session });
        
        if (antiDuplicateKeys.length > 0) {
          for (const key of antiDuplicateKeys) {
            const existing = await this.findOne({
              surveyId,
              'antiDuplicateKeys': { $elemMatch: { mode: key.mode, key: key.key } },
              _id: { $ne: saved._id }
            }).session(session);
            
            if (existing) {
              throw new Error('DUPLICATE_RESPONSE');
            }
          }
        }
      });
    } finally {
      session.endSession();
    }
    
    return { success: true, response: saved };
  } catch (err) {
    if (err.message === 'DUPLICATE_RESPONSE' || err.code === 11000) {
      const existing = await this.findOne({
        surveyId,
        $or: antiDuplicateKeys.map(k => ({
          'antiDuplicateKeys': { $elemMatch: { mode: k.mode, key: k.key } }
        }))
      }).select('id createdAt').lean();
      
      return {
        success: false,
        isDuplicate: true,
        existing
      };
    }
    throw err;
  }
};

responseSchema.statics.buildFilterQuery = function(surveyId, filters = {}) {
  const query = { surveyId };
  
  if (filters.version !== undefined && filters.version !== null && filters.version !== '') {
    query.surveyVersion = Number(filters.version);
  }
  
  if (filters.userId) {
    query['respondent.userId'] = filters.userId;
  }
  
  if (filters.ipAddress) {
    query['respondent.ipAddress'] = { $regex: new RegExp(`^${filters.ipAddress.replace(/\./g, '\\.')}`, 'i') };
  }
  
  if (filters.deviceId) {
    query['respondent.deviceId'] = { $regex: new RegExp(filters.deviceId, 'i') };
  }
  
  if (filters.fingerprint) {
    query['respondent.fingerprint'] = { $regex: new RegExp(filters.fingerprint, 'i') };
  }
  
  if (filters.startDate || filters.endDate) {
    query.createdAt = {};
    if (filters.startDate) {
      query.createdAt.$gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      const end = new Date(filters.endDate);
      end.setHours(23, 59, 59, 999);
      query.createdAt.$lte = end;
    }
  }
  
  if (filters.riskLevel) {
    query['quality.riskLevel'] = filters.riskLevel;
  }
  
  if (filters.riskFlag) {
    query['quality.riskFlags'] = { $in: [filters.riskFlag] };
  }
  
  if (filters.riskFlags && Array.isArray(filters.riskFlags) && filters.riskFlags.length > 0) {
    query['quality.riskFlags'] = { $all: filters.riskFlags };
  }
  
  if (filters.completionTimeMin !== undefined && filters.completionTimeMin !== null && filters.completionTimeMin !== '') {
    query['quality.completionSeconds'] = query['quality.completionSeconds'] || {};
    query['quality.completionSeconds'].$gte = Number(filters.completionTimeMin);
  }
  
  if (filters.completionTimeMax !== undefined && filters.completionTimeMax !== null && filters.completionTimeMax !== '') {
    query['quality.completionSeconds'] = query['quality.completionSeconds'] || {};
    query['quality.completionSeconds'].$lte = Number(filters.completionTimeMax);
  }
  
  return query;
};

responseSchema.statics.getFilteredResponses = async function(surveyId, filters = {}, pagination = {}) {
  const query = this.buildFilterQuery(surveyId, filters);
  
  const { page = 1, limit = 20 } = pagination;
  
  const responses = await this.find(query)
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .skip((Number(page) - 1) * Number(limit))
    .select('id surveyId surveyVersion answers respondent metadata quality createdAt')
    .lean();
    
  const total = await this.countDocuments(query);
  
  return {
    responses,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit))
    }
  };
};

const Response = mongoose.model('Response', responseSchema);

module.exports = Response;
