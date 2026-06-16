const { Survey } = require('../models/Survey');
const Response = require('../models/Response');
const ValidationService = require('../services/validationService');
const { QUESTION_TYPES } = require('../models/Question');

const getClientIp = (req) => {
  return req.ip || 
         req.headers['x-forwarded-for']?.split(',')[0] || 
         req.connection?.remoteAddress || 
         'unknown';
};

exports.submitResponse = async (req, res, next) => {
  try {
    const { surveyId } = req.params;
    const { answers, metadata, deviceId, fingerprint } = req.body;
    
    const survey = await Survey.getFullSurvey(surveyId);
    
    if (!survey) {
      return res.status(404).json({
        success: false,
        message: '问卷不存在'
      });
    }
    
    const statusValidation = ValidationService.validateSurveyStatus(survey);
    if (!statusValidation.valid) {
      return res.status(400).json({
        success: false,
        message: '问卷无法提交',
        errors: statusValidation.errors
      });
    }
    
    if (!survey.settings.allowAnonymous && !req.user) {
      return res.status(401).json({
        success: false,
        message: '此问卷需要登录才能填写'
      });
    }
    
    const respondent = {
      userId: req.user?.id || null,
      ipAddress: getClientIp(req),
      deviceId: deviceId || null,
      userAgent: req.headers['user-agent'] || null,
      fingerprint: fingerprint || null
    };
    
    const preCheck = await Response.checkDuplicate(
      surveyId,
      respondent,
      survey.antiDuplicate.mode,
      survey.antiDuplicate.cookieExpiryHours
    );
    
    if (preCheck.isDuplicate) {
      return res.status(409).json({
        success: false,
        message: '您已经提交过此问卷',
        data: {
          duplicate: true,
          mode: preCheck.mode,
          existingAt: preCheck.existingAt
        }
      });
    }
    
    const answerValidation = ValidationService.validateSurveyAnswers(
      survey,
      answers,
      survey.version
    );
    
    if (!answerValidation.valid) {
      return res.status(400).json({
        success: false,
        message: '答案验证失败',
        errors: answerValidation.errors
      });
    }
    
    const questionMap = survey.getQuestionVersionMap(survey.version);
    const formattedAnswers = answers.map(answer => ({
      questionId: answer.questionId,
      value: answer.value,
      questionType: questionMap[answer.questionId]?.type || 'unknown'
    }));
    
    const responseData = {
      surveyId,
      surveyVersion: survey.version,
      answers: formattedAnswers,
      respondent,
      metadata: metadata || {}
    };
    
    if (metadata?.startTime) {
      const startTime = new Date(metadata.startTime);
      const endTime = new Date();
      responseData.metadata.endTime = endTime;
      responseData.metadata.completionTime = Math.round((endTime - startTime) / 1000);
    }
    
    const createResult = await Response.createWithAntiDuplicate(
      responseData,
      surveyId,
      respondent,
      survey.antiDuplicate.mode,
      survey.antiDuplicate.cookieExpiryHours
    );
    
    if (!createResult.success && createResult.isDuplicate) {
      return res.status(409).json({
        success: false,
        message: '您已经提交过此问卷',
        data: {
          duplicate: true,
          mode: survey.antiDuplicate.mode,
          existingAt: createResult.existing?.createdAt
        }
      });
    }
    
    if (!createResult.success) {
      throw new Error('保存回答失败');
    }
    
    survey.responseCount += 1;
    await survey.save();
    
    res.status(201).json({
      success: true,
      message: '提交成功',
      data: {
        responseId: createResult.response.id,
        surveyVersion: createResult.response.surveyVersion,
        submittedAt: createResult.response.createdAt
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.getResponses = async (req, res, next) => {
  try {
    const { surveyId } = req.params;
    const { 
      version, 
      userId, 
      ipAddress, 
      deviceId, 
      fingerprint,
      startDate,
      endDate,
      page = 1, 
      limit = 50 
    } = req.query;
    
    const survey = await Survey.findOne({ id: surveyId });
    
    if (!survey) {
      return res.status(404).json({
        success: false,
        message: '问卷不存在'
      });
    }
    
    if (survey.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: '无权限查看此问卷的回答'
      });
    }
    
    const filters = {
      version: version !== undefined ? version : null,
      userId: userId || null,
      ipAddress: ipAddress || null,
      deviceId: deviceId || null,
      fingerprint: fingerprint || null,
      startDate: startDate || null,
      endDate: endDate || null
    };
    
    const result = await Response.getFilteredResponses(
      surveyId,
      filters,
      { page, limit }
    );
    
    const versionDistribution = await Response.getResponseCountByVersion(surveyId);
    
    res.json({
      success: true,
      data: {
        responses: result.responses,
        pagination: result.pagination,
        appliedFilters: filters,
        versionDistribution
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.getResponseDetail = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const response = await Response.findOne({ id }).lean();
    
    if (!response) {
      return res.status(404).json({
        success: false,
        message: '回答不存在'
      });
    }
    
    const survey = await Survey.findOne({ id: response.surveyId });
    
    if (!survey) {
      return res.status(404).json({
        success: false,
        message: '关联的问卷不存在'
      });
    }
    
    if (survey.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: '无权限查看此回答'
      });
    }
    
    const questions = response.surveyVersion
      ? survey.history.find(h => h.version === response.surveyVersion)?.questions || survey.questions
      : survey.questions;
    
    const answersWithQuestions = response.answers.map(answer => {
      const question = questions.find(q => q.id === answer.questionId);
      return {
        ...answer,
        question: question ? {
          id: question.id,
          title: question.title,
          type: question.type
        } : null
      };
    });
    
    res.json({
      success: true,
      data: {
        response: {
          ...response,
          answers: answersWithQuestions
        }
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.deleteResponse = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const response = await Response.findOne({ id });
    
    if (!response) {
      return res.status(404).json({
        success: false,
        message: '回答不存在'
      });
    }
    
    const survey = await Survey.findOne({ id: response.surveyId });
    
    if (!survey) {
      return res.status(404).json({
        success: false,
        message: '关联的问卷不存在'
      });
    }
    
    if (survey.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: '无权限删除此回答'
      });
    }
    
    await response.deleteOne();
    
    survey.responseCount = Math.max(0, survey.responseCount - 1);
    await survey.save();
    
    res.json({
      success: true,
      message: '回答删除成功'
    });
  } catch (err) {
    next(err);
  }
};

exports.checkCanSubmit = async (req, res, next) => {
  try {
    const { surveyId } = req.params;
    const { deviceId, fingerprint } = req.query;
    
    const survey = await Survey.getFullSurvey(surveyId);
    
    if (!survey) {
      return res.status(404).json({
        success: false,
        message: '问卷不存在'
      });
    }
    
    const statusValidation = ValidationService.validateSurveyStatus(survey);
    if (!statusValidation.valid) {
      return res.json({
        success: true,
        data: {
          canSubmit: false,
          reason: statusValidation.errors[0]
        }
      });
    }
    
    if (!survey.settings.allowAnonymous && !req.user) {
      return res.json({
        success: true,
        data: {
          canSubmit: false,
          reason: '此问卷需要登录才能填写',
          requireLogin: true
        }
      });
    }
    
    const respondent = {
      userId: req.user?.id || null,
      ipAddress: getClientIp(req),
      deviceId: deviceId || null,
      fingerprint: fingerprint || null
    };
    
    const duplicateCheck = await Response.checkDuplicate(
      surveyId,
      respondent,
      survey.antiDuplicate.mode,
      survey.antiDuplicate.cookieExpiryHours
    );
    
    if (duplicateCheck.isDuplicate) {
      return res.json({
        success: true,
        data: {
          canSubmit: false,
          reason: '您已经提交过此问卷',
          duplicate: true,
          mode: duplicateCheck.mode,
          existingAt: duplicateCheck.existingAt
        }
      });
    }
    
    res.json({
      success: true,
      data: {
        canSubmit: true,
        surveyVersion: survey.version,
        antiDuplicateMode: survey.antiDuplicate.mode
      }
    });
  } catch (err) {
    next(err);
  }
};
