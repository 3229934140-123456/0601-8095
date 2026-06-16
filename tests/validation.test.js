const ValidationService = require('../services/validationService');
const { QUESTION_TYPES } = require('../models/Question');

describe('ValidationService - 题目校验测试', () => {
  describe('validateQuestionConfig', () => {
    test('单选题配置校验 - 至少2个选项', () => {
      const question = {
        type: QUESTION_TYPES.SINGLE_CHOICE,
        config: {
          options: [{ value: 'a', label: '选项A' }]
        }
      };
      const result = ValidationService.validateQuestionConfig(question);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('选择题至少需要2个选项');
    });

    test('单选题配置校验 - 正常', () => {
      const question = {
        type: QUESTION_TYPES.SINGLE_CHOICE,
        config: {
          options: [
            { value: 'a', label: '选项A' },
            { value: 'b', label: '选项B' }
          ]
        }
      };
      const result = ValidationService.validateQuestionConfig(question);
      expect(result.valid).toBe(true);
    });

    test('多选题选项值不能重复', () => {
      const question = {
        type: QUESTION_TYPES.MULTIPLE_CHOICE,
        config: {
          options: [
            { value: 'a', label: '选项A' },
            { value: 'a', label: '选项B' }
          ]
        }
      };
      const result = ValidationService.validateQuestionConfig(question);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('选项值不能重复');
    });

    test('评分题配置校验 - 范围必须是步长整数倍', () => {
      const question = {
        type: QUESTION_TYPES.RATING,
        config: {
          min: 1,
          max: 10,
          step: 2
        }
      };
      const result = ValidationService.validateQuestionConfig(question);
      expect(result.valid).toBe(false);
    });

    test('评分题配置校验 - 正常', () => {
      const question = {
        type: QUESTION_TYPES.RATING,
        config: {
          min: 0,
          max: 10,
          step: 2
        }
      };
      const result = ValidationService.validateQuestionConfig(question);
      expect(result.valid).toBe(true);
    });
  });

  describe('validateAnswer', () => {
    test('单选题答案校验 - 必须选择有效选项', () => {
      const question = {
          type: QUESTION_TYPES.SINGLE_CHOICE,
          config: {
            options: [
              { value: 'a', label: '选项A' },
              { value: 'b', label: '选项B' }
            ]
          }
        };
      
      let result = ValidationService.validateAnswer(question, 'invalid');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('请选择有效的选项');
      
      result = ValidationService.validateAnswer(question, 'a');
      expect(result.valid).toBe(true);
    });

    test('多选题答案校验 - 必须是数组', () => {
      const question = {
          type: QUESTION_TYPES.MULTIPLE_CHOICE,
          config: {
            options: [
              { value: 'a', label: '选项A' },
              { value: 'b', label: '选项B' }
            ]
          },
          validation: {
            minSelect: 1,
            maxSelect: 2
          }
        };
      
      let result = ValidationService.validateAnswer(question, 'a');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('多选题答案必须是数组格式');
      
      result = ValidationService.validateAnswer(question, ['a', 'b', 'c']);
      expect(result.valid).toBe(false);
      
      result = ValidationService.validateAnswer(question, ['a']);
      expect(result.valid).toBe(true);
    });

    test('评分题答案校验 - 必须在范围内', () => {
      const question = {
          type: QUESTION_TYPES.RATING,
          config: {
            min: 1,
            max: 5,
            step: 1
          }
        };
      
      let result = ValidationService.validateAnswer(question, 6);
      expect(result.valid).toBe(false);
      
      result = ValidationService.validateAnswer(question, 3.5);
      expect(result.valid).toBe(false);
      
      result = ValidationService.validateAnswer(question, 3);
      expect(result.valid).toBe(true);
    });

    test('文本题答案校验 - 长度限制', () => {
      const question = {
          type: QUESTION_TYPES.TEXT,
          validation: {
            minLength: 5,
            maxLength: 10
          }
        };
      
      let result = ValidationService.validateAnswer(question, 'abc');
      expect(result.valid).toBe(false);
      
      result = ValidationService.validateAnswer(question, 'abcdefghijk');
      expect(result.valid).toBe(false);
      
      result = ValidationService.validateAnswer(question, 'abcdef');
      expect(result.valid).toBe(true);
    });

    test('必填项校验', () => {
      const question = {
          type: QUESTION_TYPES.SINGLE_CHOICE,
          required: true,
          config: {
            options: [
              { value: 'a', label: '选项A' },
              { value: 'b', label: '选项B' }
            ]
          }
        };
      
      let result = ValidationService.validateAnswer(question, null);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('此字段为必填项');
    });
  });
});
