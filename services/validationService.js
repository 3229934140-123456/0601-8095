const { Question, QUESTION_TYPES } = require('../models/Question');

class ValidationService {
  static createQuestionFromData(questionData) {
    const QuestionClass = this.getQuestionClass(questionData.type);
    return new QuestionClass(questionData);
  }

  static getQuestionClass(type) {
    switch (type) {
      case QUESTION_TYPES.SINGLE_CHOICE:
        return require('../models/Question').SingleChoiceQuestion;
      case QUESTION_TYPES.MULTIPLE_CHOICE:
        return require('../models/Question').MultipleChoiceQuestion;
      case QUESTION_TYPES.TEXT:
        return require('../models/Question').TextQuestion;
      case QUESTION_TYPES.RATING:
        return require('../models/Question').RatingQuestion;
      default:
        return Question;
    }
  }

  static validateQuestionConfig(questionData) {
    const errors = [];
    
    if (!questionData.type) {
      errors.push('题目类型不能为空');
      return { valid: false, errors };
    }
    
    if (!Object.values(QUESTION_TYPES).includes(questionData.type)) {
      errors.push(`不支持的题目类型: ${questionData.type}`);
      return { valid: false, errors };
    }

    switch (questionData.type) {
      case QUESTION_TYPES.SINGLE_CHOICE:
      case QUESTION_TYPES.MULTIPLE_CHOICE:
        if (!questionData.config?.options || questionData.config.options.length < 2) {
          errors.push('选择题至少需要2个选项');
        } else {
          const values = questionData.config.options.map(o => o.value);
          const uniqueValues = new Set(values);
          if (values.length !== uniqueValues.size) {
            errors.push('选项值不能重复');
          }
        }
        break;
        
      case QUESTION_TYPES.RATING:
        const config = questionData.config || {};
        const min = config.min ?? 1;
        const max = config.max ?? 5;
        const step = config.step ?? 1;
        
        if (min >= max) {
          errors.push('评分最小值必须小于最大值');
        }
        if (step <= 0) {
          errors.push('评分步长必须大于0');
        }
        if ((max - min) % step !== 0) {
          errors.push('评分范围必须是步长的整数倍');
        }
        break;
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  static validateAnswer(questionData, answer) {
    const question = this.createQuestionFromData(questionData);
    return question.validateAnswer(answer);
  }

  static validateSurveyAnswers(survey, answers, version = null) {
    const errors = [];
    const questionMap = survey.getQuestionVersionMap(version);
    
    const answeredQuestionIds = new Set(answers.map(a => a.questionId));
    
    for (const question of version 
      ? survey.history.find(h => h.version === version)?.questions || survey.questions
      : survey.questions
    ) {
      if (question.required && !answeredQuestionIds.has(question.id)) {
        errors.push({
          questionId: question.id,
          title: question.title,
          error: '此字段为必填项'
        });
      }
    }
    
    for (const answer of answers) {
      const question = questionMap[answer.questionId];
      
      if (!question) {
        errors.push({
          questionId: answer.questionId,
          error: '题目不存在'
        });
        continue;
      }
      
      const validation = this.validateAnswer(question, answer.value);
      if (!validation.valid) {
        errors.push({
          questionId: question.id,
          title: question.title,
          error: validation.error
        });
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  static validateSurveyStatus(survey) {
    const errors = [];
    
    if (survey.status === 'published') {
      const now = new Date();
      
      if (survey.settings.startTime && now < survey.settings.startTime) {
        errors.push('问卷尚未开始');
      }
      
      if (survey.settings.endTime && now > survey.settings.endTime) {
        errors.push('问卷已结束');
      }
      
      if (survey.settings.maxResponses && survey.responseCount >= survey.settings.maxResponses) {
        errors.push('问卷已达到最大回答数量');
      }
    } else if (survey.status === 'draft') {
      errors.push('问卷尚未发布');
    } else if (survey.status === 'closed') {
      errors.push('问卷已关闭');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
}

module.exports = ValidationService;
