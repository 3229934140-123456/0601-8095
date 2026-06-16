const mongoose = require('mongoose');
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

responseSchema.statics.checkDuplicate = async function(surveyId, respondent, mode, expiryHours = 24) {
  const expiryDate = new Date(Date.now() - expiryHours * 60 * 60 * 1000);
  
  const baseQuery = {
    surveyId,
    createdAt: { $gte: expiryDate }
  };
  
  let query = { ...baseQuery };
  
  switch (mode) {
    case 'by_user':
      if (!respondent.userId) {
        return { isDuplicate: false, reason: 'no_user_id' };
      }
      query['respondent.userId'] = respondent.userId;
      break;
      
    case 'by_ip':
      query['respondent.ipAddress'] = respondent.ipAddress;
      break;
      
    case 'by_device':
      if (!respondent.deviceId && !respondent.fingerprint) {
        return { isDuplicate: false, reason: 'no_device_identifier' };
      }
      query.$or = [];
      if (respondent.deviceId) {
        query.$or.push({ 'respondent.deviceId': respondent.deviceId });
      }
      if (respondent.fingerprint) {
        query.$or.push({ 'respondent.fingerprint': respondent.fingerprint });
      }
      break;
      
    case 'by_user_ip_device':
      query.$or = [];
      if (respondent.userId) {
        query.$or.push({ 'respondent.userId': respondent.userId });
      }
      query.$or.push({ 'respondent.ipAddress': respondent.ipAddress });
      if (respondent.deviceId) {
        query.$or.push({ 'respondent.deviceId': respondent.deviceId });
      }
      if (respondent.fingerprint) {
        query.$or.push({ 'respondent.fingerprint': respondent.fingerprint });
      }
      if (query.$or.length === 0) {
        query = { 'respondent.ipAddress': respondent.ipAddress };
      }
      break;
      
    case 'none':
    default:
      return { isDuplicate: false };
  }
  
  const existing = await this.findOne(query).select('id createdAt').lean();
  
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

const Response = mongoose.model('Response', responseSchema);

module.exports = Response;
