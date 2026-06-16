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

responseSchema.statics.generateAntiDuplicateKeys = function(surveyId, respondent, mode, expiryHours = 24) {
  const keys = [];
  const expiryBucket = Math.floor(Date.now() / (expiryHours * 3600 * 1000));
  
  const makeKey = (...parts) => {
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  };
  
  switch (mode) {
    case 'by_user':
      if (respondent.userId) {
        const key = makeKey('by_user', surveyId, String(expiryBucket), respondent.userId);
        keys.push({ mode: 'by_user', key });
      }
      break;
      
    case 'by_ip':
      if (respondent.ipAddress) {
        const key = makeKey('by_ip', surveyId, String(expiryBucket), respondent.ipAddress);
        keys.push({ mode: 'by_ip', key });
      }
      break;
      
    case 'by_device':
      if (respondent.deviceId) {
        const key = makeKey('by_device', surveyId, String(expiryBucket), respondent.deviceId);
        keys.push({ mode: 'by_device', key });
      }
      if (respondent.fingerprint) {
        const key = makeKey('by_fp', surveyId, String(expiryBucket), respondent.fingerprint);
        keys.push({ mode: 'by_fp', key });
      }
      break;
      
    case 'by_user_ip_device':
      if (respondent.userId) {
        const key = makeKey('by_user', surveyId, String(expiryBucket), respondent.userId);
        keys.push({ mode: 'by_user', key });
      }
      if (respondent.ipAddress) {
        const key = makeKey('by_ip', surveyId, String(expiryBucket), respondent.ipAddress);
        keys.push({ mode: 'by_ip', key });
      }
      if (respondent.deviceId) {
        const key = makeKey('by_device', surveyId, String(expiryBucket), respondent.deviceId);
        keys.push({ mode: 'by_device', key });
      }
      if (respondent.fingerprint) {
        const key = makeKey('by_fp', surveyId, String(expiryBucket), respondent.fingerprint);
        keys.push({ mode: 'by_fp', key });
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

const Response = mongoose.model('Response', responseSchema);

module.exports = Response;
