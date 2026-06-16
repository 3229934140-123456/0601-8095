const { Survey, SURVEY_STATUS } = require('../models/Survey');
const ValidationService = require('../services/validationService');
const crypto = require('crypto');

const getBaseUrl = (req) => {
  return `${req.protocol}://${req.get('host')}`;
};

exports.createSurvey = async (req, res, next) => {
  try {
    const { title, description, questions, settings, antiDuplicate } = req.body;
    
    for (const question of questions) {
      const validation = ValidationService.validateQuestionConfig(question);
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          message: `题目 "${question.title}" 配置错误`,
          errors: validation.errors
        });
      }
    }
    
    const survey = new Survey({
      title,
      description,
      questions,
      createdBy: req.user.id,
      settings: settings || {},
      antiDuplicate: antiDuplicate || undefined
    });
    
    const structureValidation = survey.validateQuestionStructure();
    if (!structureValidation.valid) {
      return res.status(400).json({
        success: false,
        message: '问卷结构验证失败',
        errors: structureValidation.errors
      });
    }
    
    await survey.save();
    
    res.status(201).json({
      success: true,
      message: '问卷创建成功',
      data: {
        survey: {
          id: survey.id,
          title: survey.title,
          version: survey.version,
          status: survey.status
        }
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.getSurvey = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { version } = req.query;
    
    const survey = await Survey.getFullSurvey(id);
    
    if (!survey) {
      return res.status(404).json({
        success: false,
        message: '问卷不存在'
      });
    }
    
    let responseData = {
      id: survey.id,
      title: survey.title,
      description: survey.description,
      status: survey.status,
      version: survey.version,
      createdBy: survey.createdBy,
      createdAt: survey.createdAt,
      updatedAt: survey.updatedAt,
      responseCount: survey.responseCount,
      settings: survey.settings,
      antiDuplicate: {
        mode: survey.antiDuplicate.mode
      }
    };
    
    if (version) {
      const historyVersion = survey.history.find(h => h.version === Number(version));
      if (historyVersion) {
        responseData.version = historyVersion.version;
        responseData.title = historyVersion.title;
        responseData.description = historyVersion.description;
        responseData.questions = historyVersion.questions;
      } else {
        return res.status(404).json({
          success: false,
          message: '指定的问卷版本不存在'
        });
      }
    } else {
      responseData.questions = survey.questions;
    }
    
    if (req.user && req.user.id === survey.createdBy) {
      responseData.history = survey.history;
    }
    
    const isOwner = req.user && req.user.id === survey.createdBy;
    responseData.entryStatus = survey.getFillEntryStatus(
      survey.settings?.accessMode === 'login_required' ? req.user : null
    );
    
    if (isOwner || req.user?.role === 'admin') {
      responseData.fillEntry = survey.getFillEntryInfo(getBaseUrl(req));
    }
    
    res.json({
      success: true,
      data: {
        survey: responseData
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.getFillEntry = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { password } = req.query;
    
    const survey = await Survey.findOne({ id }).select('id title description status version questions settings antiDuplicate responseCount');
    
    if (!survey) {
      return res.status(404).json({
        success: false,
        message: '问卷不存在'
      });
    }
    
    const currentUser = survey.settings?.accessMode === 'login_required' ? req.user : null;
    const entryStatus = survey.getFillEntryStatus(currentUser);
    
    if (survey.settings?.accessPassword) {
      const hashedPassword = crypto.createHash('sha256').update(String(password || '')).digest('hex');
      if (hashedPassword !== survey.settings.accessPassword) {
        entryStatus.canFill = false;
        entryStatus.reasons.push('需要访问密码');
        entryStatus.details.requirePassword = true;
      }
    }
    
    const responseData = {
      id: survey.id,
      title: survey.title,
      description: survey.description,
      version: survey.version,
      questions: entryStatus.canFill ? survey.questions : undefined,
      settings: {
        showProgress: survey.settings?.showProgress !== false,
        shuffleQuestions: survey.settings?.shuffleQuestions === true,
        welcomeMessage: survey.settings?.welcomeMessage,
        thankYouMessage: survey.settings?.thankYouMessage,
        redirectUrl: survey.settings?.redirectUrl
      },
      antiDuplicate: {
        mode: survey.antiDuplicate?.mode
      },
      entryStatus,
      fillEntry: {
        configuration: {
          accessMode: survey.settings?.accessMode || 'public',
          requireLogin: survey.settings?.accessMode === 'login_required',
          requirePassword: !!survey.settings?.accessPassword,
          startTime: survey.settings?.startTime,
          endTime: survey.settings?.endTime,
          allowAnonymous: survey.settings?.allowAnonymous !== false
        }
      }
    };
    
    res.json({
      success: true,
      data: {
        survey: responseData
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.getSurveyList = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    
    const query = {};
    if (status) {
      query.status = status;
    }
    
    if (!req.user || req.user.role !== 'admin') {
      query.createdBy = req.user.id;
    }
    
    const surveys = await Survey.find(query)
      .select('id title status version responseCount createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit))
      .lean();
    
    const total = await Survey.countDocuments(query);
    
    res.json({
      success: true,
      data: {
        surveys,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit))
        }
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.updateSurvey = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, questions, settings, antiDuplicate, changeLog } = req.body;
    
    const survey = await Survey.findOne({ id });
    
    if (!survey) {
      return res.status(404).json({
        success: false,
        message: '问卷不存在'
      });
    }
    
    if (survey.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: '无权限修改此问卷'
      });
    }
    
    const hasResponses = await survey.hasResponses();
    
    if (questions) {
      for (const question of questions) {
        const validation = ValidationService.validateQuestionConfig(question);
        if (!validation.valid) {
          return res.status(400).json({
            success: false,
            message: `题目 "${question.title}" 配置错误`,
            errors: validation.errors
          });
        }
      }
      
      const tempSurvey = new Survey({ ...survey.toObject(), questions });
      const structureValidation = tempSurvey.validateQuestionStructure();
      if (!structureValidation.valid) {
        return res.status(400).json({
          success: false,
          message: '问卷结构验证失败',
          errors: structureValidation.errors
        });
      }
      
      survey.questions = questions;
    }
    
    if (title !== undefined) survey.title = title;
    if (description !== undefined) survey.description = description;
    if (settings) survey.settings = { ...survey.settings, ...settings };
    if (antiDuplicate) survey.antiDuplicate = { ...survey.antiDuplicate, ...antiDuplicate };
    
    await survey.saveWithHistory(changeLog);
    
    res.json({
      success: true,
      message: '问卷更新成功',
      data: {
        survey: {
          id: survey.id,
          version: survey.version,
          hasResponses,
          previousVersion: survey.version - 1
        }
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.updateSurveyStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!Object.values(SURVEY_STATUS).includes(status)) {
      return res.status(400).json({
        success: false,
        message: '无效的状态值'
      });
    }
    
    const survey = await Survey.findOne({ id });
    
    if (!survey) {
      return res.status(404).json({
        success: false,
        message: '问卷不存在'
      });
    }
    
    if (survey.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: '无权限修改此问卷'
      });
    }
    
    if (status === SURVEY_STATUS.PUBLISHED) {
      const structureValidation = survey.validateQuestionStructure();
      if (!structureValidation.valid) {
        return res.status(400).json({
          success: false,
          message: '问卷结构不完整，无法发布',
          errors: structureValidation.errors
        });
      }
    }
    
    survey.status = status;
    await survey.save();
    
    const responseData = {
      id: survey.id,
      status: survey.status
    };
    
    if (status === SURVEY_STATUS.PUBLISHED) {
      responseData.entryStatus = survey.getFillEntryStatus();
      responseData.fillEntry = survey.getFillEntryInfo(getBaseUrl(req));
    }
    
    res.json({
      success: true,
      message: `问卷状态已更新为 ${status}`,
      data: {
        survey: responseData
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.deleteSurvey = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const survey = await Survey.findOne({ id });
    
    if (!survey) {
      return res.status(404).json({
        success: false,
        message: '问卷不存在'
      });
    }
    
    if (survey.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: '无权限删除此问卷'
      });
    }
    
    await survey.deleteOne();
    
    const Response = require('../models/Response');
    await Response.deleteMany({ surveyId: id });
    
    res.json({
      success: true,
      message: '问卷删除成功'
    });
  } catch (err) {
    next(err);
  }
};

exports.getSurveyVersions = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const survey = await Survey.findOne({ id }).select('id version history title description updatedAt createdBy');
    
    if (!survey) {
      return res.status(404).json({
        success: false,
        message: '问卷不存在'
      });
    }
    
    if (survey.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: '无权限查看此问卷的版本历史'
      });
    }
    
    const versions = [
      {
        version: survey.version,
        title: survey.title,
        description: survey.description,
        createdAt: survey.updatedAt,
        changeLog: '当前版本',
        isCurrent: true
      },
      ...survey.history.map(h => ({
        version: h.version,
        title: h.title,
        description: h.description,
        createdAt: h.createdAt,
        changeLog: h.changeLog,
        isCurrent: false
      }))
    ].sort((a, b) => b.version - a.version);
    
    res.json({
      success: true,
      data: {
        versions
      }
    });
  } catch (err) {
    next(err);
  }
};
