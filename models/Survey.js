const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { Question } = require('./Question');

const SURVEY_STATUS = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  CLOSED: 'closed'
};

const ANTI_DUPLICATE_MODES = {
  NONE: 'none',
  BY_USER: 'by_user',
  BY_IP: 'by_ip',
  BY_DEVICE: 'by_device',
  BY_USER_IP_DEVICE: 'by_user_ip_device'
};

const surveyHistorySchema = new mongoose.Schema({
  version: { type: Number, required: true },
  title: { type: String, required: true },
  description: { type: String },
  questions: { type: [Question.schema], required: true },
  createdAt: { type: Date, default: Date.now },
  changeLog: { type: String }
}, { _id: false });

const surveySchema = new mongoose.Schema({
  id: {
    type: String,
    default: uuidv4,
    unique: true
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  description: {
    type: String,
    trim: true,
    maxlength: 2000
  },
  status: {
    type: String,
    enum: Object.values(SURVEY_STATUS),
    default: SURVEY_STATUS.DRAFT
  },
  version: {
    type: Number,
    default: 1
  },
  questions: {
    type: [Question.schema],
    required: true,
    validate: {
      validator: function(v) {
        return v && v.length > 0;
      },
      message: '问卷至少需要一个问题'
    }
  },
  history: [surveyHistorySchema],
  createdBy: {
    type: String,
    required: true
  },
  antiDuplicate: {
    mode: {
      type: String,
      enum: Object.values(ANTI_DUPLICATE_MODES),
      default: ANTI_DUPLICATE_MODES.BY_IP
    },
    cookieExpiryHours: {
      type: Number,
      default: 24
    }
  },
  settings: {
    accessMode: { 
      type: String, 
      enum: ['public', 'login_required', 'invite_only'], 
      default: 'public' 
    },
    accessPassword: { type: String, default: null },
    allowAnonymous: { type: Boolean, default: true },
    showProgress: { type: Boolean, default: true },
    shuffleQuestions: { type: Boolean, default: false },
    startTime: { type: Date, default: null },
    endTime: { type: Date, default: null },
    maxResponses: { type: Number, default: null },
    redirectUrl: { type: String, default: null },
    welcomeMessage: { type: String, default: null },
    thankYouMessage: { type: String, default: null }
  },
  responseCount: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

surveySchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  
  if (this.isModified('questions') && !this.isNew) {
    const previousVersion = {
      version: this.version,
      title: this.$locals.originalTitle || this.title,
      description: this.$locals.originalDescription || this.description,
      questions: this.$locals.originalQuestions || this.questions,
      createdAt: new Date(),
      changeLog: this.$locals.changeLog || '更新了问卷题目'
    };
    
    this.history.push(previousVersion);
    this.version += 1;
  }
  
  next();
});

surveySchema.methods.saveWithHistory = async function(changeLog = '更新了问卷') {
  const original = await this.constructor.findById(this._id);
  if (original) {
    this.$locals.originalTitle = original.title;
    this.$locals.originalDescription = original.description;
    this.$locals.originalQuestions = original.questions;
    this.$locals.changeLog = changeLog;
  }
  return this.save();
};

surveySchema.methods.getQuestionById = function(questionId) {
  return this.questions.find(q => q.id === questionId);
};

surveySchema.methods.hasResponses = async function() {
  const Response = mongoose.model('Response');
  const count = await Response.countDocuments({ surveyId: this.id });
  return count > 0;
};

surveySchema.methods.getQuestionVersionMap = function(version = null) {
  const questions = version 
    ? this.history.find(h => h.version === version)?.questions || this.questions
    : this.questions;
  
  return questions.reduce((map, q) => {
    map[q.id] = q;
    return map;
  }, {});
};

surveySchema.methods.validateQuestionStructure = function() {
  const errors = [];
  const questionIds = new Set();
  
  for (const question of this.questions) {
    if (questionIds.has(question.id)) {
      errors.push(`题目ID重复: ${question.id}`);
    }
    questionIds.add(question.id);
    
    if (!question.title || question.title.trim() === '') {
      errors.push(`题目 ${question.order} 标题不能为空`);
    }
  }
  
  if (errors.length > 0) {
    return { valid: false, errors };
  }
  
  return { valid: true };
};

surveySchema.methods.getFillEntryStatus = function(currentUser = null) {
  const now = Date.now();
  const reasons = [];
  
  let canFill = true;
  
  if (this.status !== SURVEY_STATUS.PUBLISHED) {
    canFill = false;
    reasons.push(this.status === SURVEY_STATUS.DRAFT ? '问卷尚未发布' : '问卷已关闭');
  }
  
  if (this.settings?.startTime && now < new Date(this.settings.startTime).getTime()) {
    canFill = false;
    reasons.push(`填写尚未开始，将于 ${new Date(this.settings.startTime).toLocaleString()} 开放`);
  }
  
  if (this.settings?.endTime && now > new Date(this.settings.endTime).getTime()) {
    canFill = false;
    reasons.push('填写已截止');
  }
  
  if (this.settings?.maxResponses && this.responseCount >= this.settings.maxResponses) {
    canFill = false;
    reasons.push(`已达到最大填写数量限制 (${this.settings.maxResponses})`);
  }
  
  if (this.settings?.accessMode === 'login_required' && !currentUser) {
    canFill = false;
    reasons.push('需要登录后才能填写');
  }
  
  return {
    canFill,
    reasons,
    details: {
      status: this.status,
      accessMode: this.settings?.accessMode || 'public',
      requireLogin: this.settings?.accessMode === 'login_required',
      requirePassword: !!this.settings?.accessPassword,
      timeActive: !(this.settings?.startTime && now < new Date(this.settings.startTime).getTime()) &&
                  !(this.settings?.endTime && now > new Date(this.settings.endTime).getTime()),
      withinLimit: !this.settings?.maxResponses || this.responseCount < this.settings.maxResponses
    }
  };
};

surveySchema.methods.getFillEntryInfo = function(baseUrl = '') {
  return {
    fillUrl: `${baseUrl}/s/${this.id}`,
    embedCode: `<iframe src="${baseUrl}/s/${this.id}/embed" width="100%" height="600" frameborder="0"></iframe>`,
    qrCodeContent: `${baseUrl}/s/${this.id}`,
    shareLinks: {
      wechat: `${baseUrl}/s/${this.id}?platform=wechat`,
      qq: `${baseUrl}/s/${this.id}?platform=qq`,
      weibo: `${baseUrl}/s/${this.id}?platform=weibo`
    },
    configuration: {
      accessMode: this.settings?.accessMode || 'public',
      requireLogin: this.settings?.accessMode === 'login_required',
      requirePassword: !!this.settings?.accessPassword,
      startTime: this.settings?.startTime,
      endTime: this.settings?.endTime,
      maxResponses: this.settings?.maxResponses,
      antiDuplicateMode: this.antiDuplicate?.mode,
      allowAnonymous: this.settings?.allowAnonymous !== false,
      showProgress: this.settings?.showProgress !== false,
      shuffleQuestions: this.settings?.shuffleQuestions === true
    }
  };
};

surveySchema.statics.getFullSurvey = function(id) {
  return this.findOne({ id }).select('-__v');
};

surveySchema.index({ id: 1 });
surveySchema.index({ createdBy: 1 });
surveySchema.index({ status: 1 });
surveySchema.index({ createdAt: -1 });

const Survey = mongoose.model('Survey', surveySchema);

module.exports = {
  Survey,
  SURVEY_STATUS,
  ANTI_DUPLICATE_MODES
};
