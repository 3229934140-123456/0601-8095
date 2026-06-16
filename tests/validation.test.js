const ValidationService = require('../services/validationService');
const StatisticsService = require('../services/statisticsService');
const Response = require('../models/Response');
const { QUESTION_TYPES } = require('../models/Question');
const crypto = require('crypto');

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

    test('多选题答案校验 - 重复选项必须判为无效', () => {
      const question = {
          type: QUESTION_TYPES.MULTIPLE_CHOICE,
          config: {
            options: [
              { value: 'a', label: '选项A' },
              { value: 'b', label: '选项B' },
              { value: 'c', label: '选项C' }
            ]
          },
          validation: {
            minSelect: 1,
            maxSelect: 3
          }
        };
      
      let result = ValidationService.validateAnswer(question, ['a', 'a', 'b']);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('重复的选项值');
      expect(result.error).toContain('a');
      
      result = ValidationService.validateAnswer(question, ['a', 'a', 'a']);
      expect(result.valid).toBe(false);
      
      result = ValidationService.validateAnswer(question, ['a', 'b']);
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

describe('StatisticsService - 统计服务测试', () => {
  describe('多选题统计 - 重复选项防御', () => {
    test('统计多选题时应该自动对重复选项去重', () => {
      const question = {
        id: 'q1',
        type: QUESTION_TYPES.MULTIPLE_CHOICE,
        title: '测试多选',
        config: {
          options: [
            { value: 'a', label: '选项A' },
            { value: 'b', label: '选项B' },
            { value: 'c', label: '选项C' }
          ]
        }
      };
      
      const mockAnswers = [
        { questionId: 'q1', value: ['a', 'a', 'b'], questionType: QUESTION_TYPES.MULTIPLE_CHOICE },
        { questionId: 'q1', value: ['a', 'b'], questionType: QUESTION_TYPES.MULTIPLE_CHOICE },
        { questionId: 'q1', value: ['a', 'a', 'a', 'a'], questionType: QUESTION_TYPES.MULTIPLE_CHOICE }
      ];
      
      const stats = StatisticsService.calculateMultipleChoiceStats(question, mockAnswers);
      
      expect(stats.distribution['a']).toBe(3);
      expect(stats.distribution['b']).toBe(2);
      expect(stats.distribution['c']).toBe(0);
      expect(stats.totalSelections).toBe(5);
      expect(stats.selectionCountDistribution[1]).toBe(1);
      expect(stats.selectionCountDistribution[2]).toBe(2);
    });
  });
});

describe('Response - 防重机制测试', () => {
  describe('generateAntiDuplicateKeys', () => {
    test('按用户模式生成防重键', () => {
      const keys = Response.generateAntiDuplicateKeys(
        'survey123',
        { userId: 'user1', ipAddress: '1.1.1.1' },
        'by_user',
        24
      );
      
      expect(keys).toHaveLength(1);
      expect(keys[0].mode).toBe('by_user');
      expect(keys[0].key).toMatch(/^[a-f0-9]{64}$/);
    });
    
    test('按IP模式生成防重键', () => {
      const keys = Response.generateAntiDuplicateKeys(
        'survey123',
        { userId: null, ipAddress: '192.168.1.1' },
        'by_ip',
        24
      );
      
      expect(keys).toHaveLength(1);
      expect(keys[0].mode).toBe('by_ip');
    });
    
    test('按设备模式生成防重键', () => {
      const keys = Response.generateAntiDuplicateKeys(
        'survey123',
        { userId: null, ipAddress: '1.1.1.1', deviceId: 'device123', fingerprint: 'fp_abc' },
        'by_device',
        24
      );
      
      expect(keys).toHaveLength(2);
      expect(keys.map(k => k.mode)).toContain('by_device');
      expect(keys.map(k => k.mode)).toContain('by_fp');
    });
    
    test('组合模式生成多个防重键', () => {
      const keys = Response.generateAntiDuplicateKeys(
        'survey123',
        { userId: 'user1', ipAddress: '1.1.1.1', deviceId: 'dev1', fingerprint: 'fp1' },
        'by_user_ip_device',
        24
      );
      
      expect(keys).toHaveLength(4);
      expect(keys.map(k => k.mode)).toEqual(expect.arrayContaining(['by_user', 'by_ip', 'by_device', 'by_fp']));
    });
    
    test('不同问卷ID应该生成不同的防重键', () => {
      const keys1 = Response.generateAntiDuplicateKeys('surveyA', { userId: 'user1' }, 'by_user', 24);
      const keys2 = Response.generateAntiDuplicateKeys('surveyB', { userId: 'user1' }, 'by_user', 24);
      
      expect(keys1[0].key).not.toBe(keys2[0].key);
    });
    
    test('不同用户应该生成不同的防重键', () => {
      const keys1 = Response.generateAntiDuplicateKeys('survey1', { userId: 'user1' }, 'by_user', 24);
      const keys2 = Response.generateAntiDuplicateKeys('survey1', { userId: 'user2' }, 'by_user', 24);
      
      expect(keys1[0].key).not.toBe(keys2[0].key);
    });
    
    test('none模式不生成防重键', () => {
      const keys = Response.generateAntiDuplicateKeys('survey1', { userId: 'user1', ipAddress: '1.1.1.1' }, 'none', 24);
      
      expect(keys).toHaveLength(0);
    });
  });
});
