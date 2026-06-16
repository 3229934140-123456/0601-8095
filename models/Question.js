const mongoose = require('mongoose');

const QUESTION_TYPES = {
  SINGLE_CHOICE: 'single_choice',
  MULTIPLE_CHOICE: 'multiple_choice',
  TEXT: 'text',
  RATING: 'rating'
};

const baseOptions = {
  discriminatorKey: 'type',
  _id: false
};

const questionSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 500
  },
  description: {
    type: String,
    trim: true,
    maxlength: 1000
  },
  required: {
    type: Boolean,
    default: false
  },
  order: {
    type: Number,
    required: true
  },
  config: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  validation: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, baseOptions);

questionSchema.methods.validateAnswer = function(answer) {
  if (this.required && (answer === undefined || answer === null || answer === '')) {
    return { valid: false, error: '此字段为必填项' };
  }
  
  if (!this.required && (answer === undefined || answer === null || answer === '')) {
    return { valid: true };
  }
  
  return this._validateByType(answer);
};

questionSchema.methods._validateByType = function(answer) {
  return { valid: true };
};

const Question = mongoose.model('Question', questionSchema);

const SingleChoiceQuestion = Question.discriminator(QUESTION_TYPES.SINGLE_CHOICE, 
  new mongoose.Schema({
    config: {
      options: {
        type: [{
          value: String,
          label: String
        }],
        required: true,
        validate: {
          validator: function(v) {
            return v && v.length >= 2;
          },
          message: '单选题至少需要2个选项'
        }
      }
    }
  })
);

SingleChoiceQuestion.prototype._validateByType = function(answer) {
  const validValues = this.config.options.map(opt => opt.value);
  if (!validValues.includes(answer)) {
    return { valid: false, error: '请选择有效的选项' };
  }
  return { valid: true };
};

const MultipleChoiceQuestion = Question.discriminator(QUESTION_TYPES.MULTIPLE_CHOICE,
  new mongoose.Schema({
    config: {
      options: {
        type: [{
          value: String,
          label: String
        }],
        required: true,
        validate: {
          validator: function(v) {
            return v && v.length >= 2;
          },
          message: '多选题至少需要2个选项'
        }
      }
    },
    validation: {
      minSelect: { type: Number, default: 1 },
      maxSelect: { type: Number, default: null }
    }
  })
);

MultipleChoiceQuestion.prototype._validateByType = function(answer) {
  if (!Array.isArray(answer)) {
    return { valid: false, error: '多选题答案必须是数组格式' };
  }
  
  const validValues = this.config.options.map(opt => opt.value);
  const invalidValues = answer.filter(val => !validValues.includes(val));
  
  if (invalidValues.length > 0) {
    return { valid: false, error: '包含无效的选项值' };
  }
  
  if (answer.length < this.validation.minSelect) {
    return { valid: false, error: `至少需要选择 ${this.validation.minSelect} 个选项` };
  }
  
  if (this.validation.maxSelect && answer.length > this.validation.maxSelect) {
    return { valid: false, error: `最多只能选择 ${this.validation.maxSelect} 个选项` };
  }
  
  return { valid: true };
};

const TextQuestion = Question.discriminator(QUESTION_TYPES.TEXT,
  new mongoose.Schema({
    config: {
      multiline: { type: Boolean, default: false },
      placeholder: { type: String, default: '' }
    },
    validation: {
      minLength: { type: Number, default: 0 },
      maxLength: { type: Number, default: 2000 },
      pattern: { type: String, default: null }
    }
  })
);

TextQuestion.prototype._validateByType = function(answer) {
  if (typeof answer !== 'string') {
    return { valid: false, error: '文本题答案必须是字符串' };
  }
  
  if (answer.length < this.validation.minLength) {
    return { valid: false, error: `答案长度不能少于 ${this.validation.minLength} 个字符` };
  }
  
  if (answer.length > this.validation.maxLength) {
    return { valid: false, error: `答案长度不能超过 ${this.validation.maxLength} 个字符` };
  }
  
  if (this.validation.pattern) {
    const regex = new RegExp(this.validation.pattern);
    if (!regex.test(answer)) {
      return { valid: false, error: '答案格式不正确' };
    }
  }
  
  return { valid: true };
};

const RatingQuestion = Question.discriminator(QUESTION_TYPES.RATING,
  new mongoose.Schema({
    config: {
      min: { type: Number, default: 1 },
      max: { type: Number, default: 5 },
      step: { type: Number, default: 1 },
      labels: {
        type: Map,
        of: String,
        default: {}
      }
    }
  })
);

RatingQuestion.prototype._validateByType = function(answer) {
  if (typeof answer !== 'number' || isNaN(answer)) {
    return { valid: false, error: '评分题答案必须是数字' };
  }
  
  if (answer < this.config.min || answer > this.config.max) {
    return { valid: false, error: `评分必须在 ${this.config.min} 到 ${this.config.max} 之间` };
  }
  
  const steps = Math.round((answer - this.config.min) / this.config.step);
  const expectedValue = this.config.min + steps * this.config.step;
  if (Math.abs(answer - expectedValue) > 0.001) {
    return { valid: false, error: `评分步长必须是 ${this.config.step} 的倍数` };
  }
  
  return { valid: true };
};

module.exports = {
  Question,
  SingleChoiceQuestion,
  MultipleChoiceQuestion,
  TextQuestion,
  RatingQuestion,
  QUESTION_TYPES
};
