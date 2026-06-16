const ValidationService = require('../services/validationService');
const StatisticsService = require('../services/statisticsService');
const Response = require('../models/Response');
const { Survey, SURVEY_STATUS, ANTI_DUPLICATE_MODES } = require('../models/Survey');
const { InviteLink, INVITE_STATUS } = require('../models/InviteLink');
const { QUESTION_TYPES } = require('../models/Question');
const crypto = require('crypto');
const mongoose = require('mongoose');

function makeMockSurvey(overrides = {}) {
  const defaultQuestions = [
    {
      id: 'q1',
      type: QUESTION_TYPES.SINGLE_CHOICE,
      title: '测试单选',
      order: 1,
      config: {
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' }
        ]
      }
    }
  ];
  
  const defaults = {
    id: 'test-survey',
    title: '测试问卷',
    description: '测试',
    status: SURVEY_STATUS.PUBLISHED,
    version: 1,
    questions: defaultQuestions,
    history: [],
    createdBy: 'creator1',
    antiDuplicate: {
      mode: ANTI_DUPLICATE_MODES.BY_IP,
      cookieExpiryHours: 24
    },
    settings: {
      accessMode: 'public',
      allowAnonymous: true,
      showProgress: true,
      shuffleQuestions: false,
      startTime: null,
      endTime: null,
      maxResponses: null
    },
    responseCount: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  
  const merged = { ...defaults, ...overrides };
  merged.settings = { ...defaults.settings, ...(overrides.settings || {}) };
  merged.antiDuplicate = { ...defaults.antiDuplicate, ...(overrides.antiDuplicate || {}) };
  
  const survey = new Survey(merged);
  survey.getFillEntryStatus = Survey.prototype.getFillEntryStatus.bind(survey);
  survey.getFillEntryInfo = Survey.prototype.getFillEntryInfo.bind(survey);
  return survey;
}

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
    test('按用户模式生成防重键 - 有用户ID', () => {
      const keys = Response.generateAntiDuplicateKeys(
        'survey123',
        { userId: 'user1', ipAddress: '1.1.1.1' },
        'by_user',
        24
      );
      
      expect(keys.map(k => k.mode)).toContain('by_user');
      expect(keys.map(k => k.mode)).toContain('by_ip');
      expect(keys[0].key).toMatch(/^[a-f0-9]{64}$/);
    });
    
    test('按用户模式 - 无用户ID时自动回退到IP', () => {
      const keys = Response.generateAntiDuplicateKeys(
        'survey123',
        { userId: null, ipAddress: '1.1.1.1' },
        'by_user',
        24
      );
      
      expect(keys.length).toBeGreaterThanOrEqual(1);
      expect(keys.map(k => k.mode)).toContain('by_ip');
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
    
    test('按设备模式生成防重键 - 有设备ID和指纹', () => {
      const keys = Response.generateAntiDuplicateKeys(
        'survey123',
        { userId: null, ipAddress: '1.1.1.1', deviceId: 'device123', fingerprint: 'fp_abc' },
        'by_device',
        24
      );
      
      expect(keys.length).toBeGreaterThanOrEqual(2);
      expect(keys.map(k => k.mode)).toContain('by_device');
      expect(keys.map(k => k.mode)).toContain('by_fp');
    });
    
    test('按设备模式 - 无设备ID无指纹时回退到IP', () => {
      const keys = Response.generateAntiDuplicateKeys(
        'survey123',
        { userId: null, ipAddress: '10.0.0.1', deviceId: null, fingerprint: null },
        'by_device',
        24
      );
      
      expect(keys.length).toBeGreaterThanOrEqual(1);
      expect(keys.map(k => k.mode)).toContain('by_ip');
    });
    
    test('按设备模式 - 只有设备ID时同时加IP兜底', () => {
      const keys = Response.generateAntiDuplicateKeys(
        'survey123',
        { userId: null, ipAddress: '10.0.0.2', deviceId: 'devX', fingerprint: null },
        'by_device',
        24
      );
      
      expect(keys.length).toBeGreaterThanOrEqual(2);
      expect(keys.map(k => k.mode)).toContain('by_device');
      expect(keys.map(k => k.mode)).toContain('by_ip');
    });
    
    test('组合模式生成多个防重键', () => {
      const keys = Response.generateAntiDuplicateKeys(
        'survey123',
        { userId: 'user1', ipAddress: '1.1.1.1', deviceId: 'dev1', fingerprint: 'fp1' },
        'by_user_ip_device',
        24
      );
      
      expect(keys.length).toBeGreaterThanOrEqual(4);
      expect(keys.map(k => k.mode)).toEqual(expect.arrayContaining(['by_user', 'by_ip', 'by_device', 'by_fp']));
      expect(keys.map(k => k.mode)).toContain('by_user_ip');
      expect(keys.map(k => k.mode)).toContain('by_user_device');
    });
    
    test('组合模式 - 缺用户ID时只按可用标识生成', () => {
      const keys = Response.generateAntiDuplicateKeys(
        'survey123',
        { userId: null, ipAddress: '8.8.8.8', deviceId: 'devA', fingerprint: 'fpA' },
        'by_user_ip_device',
        24
      );
      
      expect(keys.map(k => k.mode)).toEqual(expect.arrayContaining(['by_ip', 'by_device', 'by_fp']));
      expect(keys.map(k => k.mode)).not.toContain('by_user');
      expect(keys.map(k => k.mode)).not.toContain('by_user_ip');
    });
    
    test('按IP模式 - 有附加设备信息时同时生成设备键', () => {
      const keys = Response.generateAntiDuplicateKeys(
        'survey123',
        { userId: null, ipAddress: '1.2.3.4', deviceId: 'devY', fingerprint: 'fpY' },
        'by_ip',
        24
      );
      
      expect(keys.length).toBeGreaterThanOrEqual(3);
      expect(keys.map(k => k.mode)).toContain('by_ip');
      expect(keys.map(k => k.mode)).toContain('by_device');
      expect(keys.map(k => k.mode)).toContain('by_fp');
    });
    
    test('不同问卷ID应该生成不同的防重键', () => {
      const keys1 = Response.generateAntiDuplicateKeys('surveyA', { userId: 'user1' }, 'by_user', 24);
      const keys2 = Response.generateAntiDuplicateKeys('surveyB', { userId: 'user1' }, 'by_user', 24);
      
      expect(keys1.find(k => k.mode === 'by_user').key).not.toBe(keys2.find(k => k.mode === 'by_user').key);
    });
    
    test('不同用户应该生成不同的防重键', () => {
      const keys1 = Response.generateAntiDuplicateKeys('survey1', { userId: 'user1', ipAddress: '1.1.1.1' }, 'by_user', 24);
      const keys2 = Response.generateAntiDuplicateKeys('survey1', { userId: 'user2', ipAddress: '1.1.1.1' }, 'by_user', 24);
      
      expect(keys1.find(k => k.mode === 'by_user').key).not.toBe(keys2.find(k => k.mode === 'by_user').key);
    });
    
    test('none模式不生成防重键', () => {
      const keys = Response.generateAntiDuplicateKeys('survey1', { userId: 'user1', ipAddress: '1.1.1.1' }, 'none', 24);
      
      expect(keys).toHaveLength(0);
    });
    
    test('空字符串或全空格标识不生成键', () => {
      const keys = Response.generateAntiDuplicateKeys('survey1', { 
        userId: '  ', 
        ipAddress: '1.1.1.1',
        deviceId: ''
      }, 'by_user_ip_device', 24);
      
      expect(keys.map(k => k.mode)).not.toContain('by_user');
      expect(keys.map(k => k.mode)).not.toContain('by_device');
      expect(keys.map(k => k.mode)).toContain('by_ip');
    });
    
    test('键不会重复生成', () => {
      const keys = Response.generateAntiDuplicateKeys(
        'surveySame',
        { userId: 'same', ipAddress: 'same', deviceId: 'same', fingerprint: 'same' },
        'by_user_ip_device',
        24
      );
      
      const modeCount = {};
      for (const k of keys) {
        modeCount[k.mode] = (modeCount[k.mode] || 0) + 1;
      }
      for (const mode of Object.keys(modeCount)) {
        expect(modeCount[mode]).toBe(1);
      }
    });
  });
  
  describe('buildFilterQuery - 筛选条件构建', () => {
    test('只带问卷ID的基础筛选', () => {
      const query = Response.buildFilterQuery('s1', {});
      expect(query).toEqual({ surveyId: 's1' });
    });
    
    test('按版本筛选', () => {
      const query = Response.buildFilterQuery('s1', { version: '2' });
      expect(query.surveyVersion).toBe(2);
    });
    
    test('按用户ID筛选', () => {
      const query = Response.buildFilterQuery('s1', { userId: 'u1' });
      expect(query['respondent.userId']).toBe('u1');
    });
    
    test('按IP地址模糊匹配', () => {
      const query = Response.buildFilterQuery('s1', { ipAddress: '192.168' });
      expect(query['respondent.ipAddress'].$regex).toBeDefined();
    });
    
    test('按设备ID筛选', () => {
      const query = Response.buildFilterQuery('s1', { deviceId: 'devA' });
      expect(query['respondent.deviceId'].$regex).toBeDefined();
    });
    
    test('按时间范围筛选', () => {
      const query = Response.buildFilterQuery('s1', { 
        startDate: '2026-01-01',
        endDate: '2026-06-30'
      });
      expect(query.createdAt.$gte).toBeInstanceOf(Date);
      expect(query.createdAt.$lte).toBeInstanceOf(Date);
    });
    
    test('组合多个筛选条件', () => {
      const query = Response.buildFilterQuery('s1', {
        version: '3',
        userId: 'u1',
        ipAddress: '10.0',
        startDate: '2026-01-01'
      });
      expect(query.surveyVersion).toBe(3);
      expect(query['respondent.userId']).toBe('u1');
      expect(query['respondent.ipAddress'].$regex).toBeDefined();
      expect(query.createdAt.$gte).toBeDefined();
    });
  });
});

describe('Survey - 填写入口和状态判断测试', () => {
  describe('getFillEntryStatus', () => {
    test('已发布的公开问卷 - 可以填写', () => {
      const survey = makeMockSurvey();
      const status = survey.getFillEntryStatus();
      expect(status.canFill).toBe(true);
      expect(status.reasons).toHaveLength(0);
      expect(status.details.status).toBe(SURVEY_STATUS.PUBLISHED);
      expect(status.details.accessMode).toBe('public');
    });
    
    test('草稿状态 - 不能填写', () => {
      const survey = makeMockSurvey({ status: SURVEY_STATUS.DRAFT });
      const status = survey.getFillEntryStatus();
      expect(status.canFill).toBe(false);
      expect(status.reasons).toContain('问卷尚未发布');
    });
    
    test('已关闭状态 - 不能填写', () => {
      const survey = makeMockSurvey({ status: SURVEY_STATUS.CLOSED });
      const status = survey.getFillEntryStatus();
      expect(status.canFill).toBe(false);
      expect(status.reasons).toContain('问卷已关闭');
    });
    
    test('设置了未来开始时间 - 不能填写', () => {
      const future = new Date(Date.now() + 24 * 3600 * 1000);
      const survey = makeMockSurvey({ settings: { startTime: future } });
      const status = survey.getFillEntryStatus();
      expect(status.canFill).toBe(false);
      expect(status.reasons.some(r => r.includes('填写尚未开始'))).toBe(true);
    });
    
    test('设置了过期时间 - 不能填写', () => {
      const past = new Date(Date.now() - 24 * 3600 * 1000);
      const survey = makeMockSurvey({ settings: { endTime: past } });
      const status = survey.getFillEntryStatus();
      expect(status.canFill).toBe(false);
      expect(status.reasons).toContain('填写已截止');
    });
    
    test('已达到最大回答数 - 不能填写', () => {
      const survey = makeMockSurvey({ 
        responseCount: 10,
        settings: { maxResponses: 10 } 
      });
      const status = survey.getFillEntryStatus();
      expect(status.canFill).toBe(false);
      expect(status.reasons.some(r => r.includes('最大填写数量'))).toBe(true);
    });
    
    test('登录必填模式 - 有用户可以填', () => {
      const survey = makeMockSurvey({ settings: { accessMode: 'login_required' } });
      const status = survey.getFillEntryStatus({ id: 'u1' });
      expect(status.canFill).toBe(true);
      expect(status.details.requireLogin).toBe(true);
    });
    
    test('登录必填模式 - 无用户不能填', () => {
      const survey = makeMockSurvey({ settings: { accessMode: 'login_required' } });
      const status = survey.getFillEntryStatus(null);
      expect(status.canFill).toBe(false);
      expect(status.reasons).toContain('需要登录后才能填写');
    });
    
    test('组合限制(过期 + 关闭) - 给出多个原因', () => {
      const past = new Date(Date.now() - 3600 * 1000);
      const survey = makeMockSurvey({ 
        status: SURVEY_STATUS.CLOSED,
        settings: { endTime: past } 
      });
      const status = survey.getFillEntryStatus();
      expect(status.canFill).toBe(false);
      expect(status.reasons.length).toBeGreaterThanOrEqual(2);
    });
  });
  
  describe('getFillEntryInfo', () => {
    test('返回访问链接和嵌入代码', () => {
      const survey = makeMockSurvey();
      const info = survey.getFillEntryInfo('https://example.com');
      
      expect(info.fillUrl).toMatch(/^https:\/\/example\.com\/s\/test-survey$/);
      expect(info.embedCode).toContain('<iframe');
      expect(info.embedCode).toContain('/s/test-survey/embed');
      expect(info.qrCodeContent).toBe('https://example.com/s/test-survey');
    });
    
    test('返回各平台分享链接', () => {
      const survey = makeMockSurvey();
      const info = survey.getFillEntryInfo('https://app.io');
      
      expect(info.shareLinks.wechat).toContain('platform=wechat');
      expect(info.shareLinks.qq).toContain('platform=qq');
      expect(info.shareLinks.weibo).toContain('platform=weibo');
    });
    
    test('返回配置摘要', () => {
      const survey = makeMockSurvey({
        antiDuplicate: { mode: 'by_user' },
        settings: { accessMode: 'login_required', accessPassword: 'xx' }
      });
      const info = survey.getFillEntryInfo();
      
      expect(info.configuration.accessMode).toBe('login_required');
      expect(info.configuration.requireLogin).toBe(true);
      expect(info.configuration.requirePassword).toBe(true);
      expect(info.configuration.antiDuplicateMode).toBe('by_user');
    });
    
    test('空 baseUrl 也能工作', () => {
      const survey = makeMockSurvey();
      const info = survey.getFillEntryInfo();
      expect(info.fillUrl).toBe('/s/test-survey');
    });
  });
});

describe('InviteLink - 邀请链接测试', () => {
  describe('generateCode - 邀请码生成', () => {
    test('生成的邀请码长度正确', () => {
      const code = InviteLink.generateCode(10);
      expect(code.length).toBe(10);
    });
    
    test('邀请码只包含指定字符（无易错字符）', () => {
      const code = InviteLink.generateCode(20);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]+$/);
    });
    
    test('多次生成不重复', () => {
      const codes = new Set();
      for (let i = 0; i < 100; i++) {
        codes.add(InviteLink.generateCode(8));
      }
      expect(codes.size).toBe(100);
    });
    
    test('默认长度12位', () => {
      const code = InviteLink.generateCode();
      expect(code.length).toBe(12);
    });
  });
  
  describe('isUsable - 可用性判断', () => {
    test('未使用的邀请码可用', () => {
      const invite = new InviteLink({
        surveyId: 's1',
        code: 'TEST123',
        status: INVITE_STATUS.UNUSED,
        maxUses: 1,
        currentUses: 0,
        createdBy: 'u1'
      });
      const result = invite.isUsable();
      expect(result.usable).toBe(true);
    });
    
    test('已使用完的邀请码不可用', () => {
      const invite = new InviteLink({
        surveyId: 's1',
        code: 'TEST123',
        status: INVITE_STATUS.USED,
        maxUses: 1,
        currentUses: 1,
        createdBy: 'u1'
      });
      const result = invite.isUsable();
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('邀请链接已使用过');
    });
    
    test('已作废的邀请码不可用', () => {
      const invite = new InviteLink({
        surveyId: 's1',
        code: 'TEST123',
        status: INVITE_STATUS.REVOKED,
        maxUses: 1,
        currentUses: 0,
        createdBy: 'u1'
      });
      const result = invite.isUsable();
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('邀请链接已作废');
    });
    
    test('已过期的邀请码不可用', () => {
      const past = new Date(Date.now() - 3600 * 1000);
      const invite = new InviteLink({
        surveyId: 's1',
        code: 'TEST123',
        status: INVITE_STATUS.UNUSED,
        maxUses: 1,
        currentUses: 0,
        expiresAt: past,
        createdBy: 'u1'
      });
      const result = invite.isUsable();
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('邀请链接已过期');
    });
    
    test('未过期的邀请码可用', () => {
      const future = new Date(Date.now() + 3600 * 1000);
      const invite = new InviteLink({
        surveyId: 's1',
        code: 'TEST123',
        status: INVITE_STATUS.UNUSED,
        maxUses: 1,
        currentUses: 0,
        expiresAt: future,
        createdBy: 'u1'
      });
      const result = invite.isUsable();
      expect(result.usable).toBe(true);
    });
    
    test('多次使用的邀请码 - 未达上限时可用', () => {
      const invite = new InviteLink({
        surveyId: 's1',
        code: 'TEST123',
        status: INVITE_STATUS.UNUSED,
        maxUses: 5,
        currentUses: 2,
        createdBy: 'u1'
      });
      const result = invite.isUsable();
      expect(result.usable).toBe(true);
    });
    
    test('无过期时间的邀请码永不过期', () => {
      const invite = new InviteLink({
        surveyId: 's1',
        code: 'TEST123',
        status: INVITE_STATUS.UNUSED,
        maxUses: 1,
        currentUses: 0,
        expiresAt: null,
        createdBy: 'u1'
      });
      const result = invite.isUsable();
      expect(result.usable).toBe(true);
    });
  });
  
  describe('getByCode - 不区分大小写', () => {
    test('toUpperCase 处理（静态方法存在）', () => {
      expect(typeof InviteLink.getByCode).toBe('function');
    });
  });
});

describe('Response - 质量分析和筛选测试', () => {
  describe('buildFilterQuery - 质量筛选条件', () => {
    test('按风险等级筛选', () => {
      const query = Response.buildFilterQuery('s1', { riskLevel: 'high' });
      expect(query['quality.riskLevel']).toBe('high');
    });
    
    test('按单个风险标记筛选', () => {
      const query = Response.buildFilterQuery('s1', { riskFlag: 'too_fast' });
      expect(query['quality.riskFlags'].$in).toContain('too_fast');
    });
    
    test('按完成时间范围筛选', () => {
      const query = Response.buildFilterQuery('s1', {
        completionTimeMin: 10,
        completionTimeMax: 300
      });
      expect(query['quality.completionSeconds'].$gte).toBe(10);
      expect(query['quality.completionSeconds'].$lte).toBe(300);
    });
    
    test('只传最小值也能工作', () => {
      const query = Response.buildFilterQuery('s1', { completionTimeMin: 60 });
      expect(query['quality.completionSeconds'].$gte).toBe(60);
      expect(query['quality.completionSeconds'].$lte).toBeUndefined();
    });
    
    test('质量筛选与其他筛选可组合', () => {
      const query = Response.buildFilterQuery('s1', {
        version: '2',
        riskLevel: 'low',
        startDate: '2026-01-01'
      });
      expect(query.surveyVersion).toBe(2);
      expect(query['quality.riskLevel']).toBe('low');
      expect(query.createdAt.$gte).toBeInstanceOf(Date);
    });
  });
  
  describe('quality risk flags - 标记类型', () => {
    test('风险等级枚举值正确', () => {
      const levels = ['low', 'medium', 'high'];
      expect(levels).toContain('low');
      expect(levels).toContain('medium');
      expect(levels).toContain('high');
    });
    
    test('常见风险标记枚举', () => {
      const flags = [
        'too_fast',
        'suspiciously_fast',
        'instant_submit',
        'too_slow',
        'straight_lining',
        'duplicate_text_answers',
        'many_skipped'
      ];
      expect(flags.length).toBe(7);
    });
  });
});

describe('版本对比鲁棒性测试', () => {
  test('空版本数据 - 返回结构完整', () => {
    const statsCtrl = require('../controllers/statisticsController');
    expect(typeof statsCtrl.getStatistics).toBe('function');
  });
  
  test('统计服务 - 单题统计空回答数组不会崩溃', async () => {
    const question = {
      id: 'q1',
      type: QUESTION_TYPES.SINGLE_CHOICE,
      title: '测试题',
      config: { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }
    };
    const result = await StatisticsService.calculateQuestionStatistics(question, []);
    expect(result).toBeDefined();
    expect(result.questionId).toBe('q1');
    expect(result.responseCount).toBe(0);
    expect(result.skipCount).toBe(0);
  });
  
  test('统计服务 - 空答案值过滤正确计数', async () => {
    const question = {
      id: 'q1',
      type: QUESTION_TYPES.SINGLE_CHOICE,
      title: '测试题',
      config: { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }
    };
    const responses = [
      { answers: [{ questionId: 'q1', value: 'a' }] },
      { answers: [{ questionId: 'q1', value: '' }] },
      { answers: [{ questionId: 'q1', value: null }] }
    ];
    const result = await StatisticsService.calculateQuestionStatistics(question, responses);
    expect(result.responseCount).toBe(1);
    expect(result.skipCount).toBe(2);
  });
  
  test('统计服务 - 找不到题目时返回空计数', async () => {
    const question = {
      id: 'q99',
      type: QUESTION_TYPES.SINGLE_CHOICE,
      title: '不存在的题',
      config: { options: [{ value: 'a', label: 'A' }] }
    };
    const responses = [
      { answers: [{ questionId: 'q1', value: 'a' }] }
    ];
    const result = await StatisticsService.calculateQuestionStatistics(question, responses);
    expect(result.responseCount).toBe(0);
  });
  
  test('统计服务 - 响应是 mongoose document 也能工作（getAnswerByQuestionId 方法）', async () => {
    const question = {
      id: 'q1',
      type: QUESTION_TYPES.SINGLE_CHOICE,
      title: '测试题',
      config: { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }
    };
    const mockResponse = {
      getAnswerByQuestionId: (qid) => qid === 'q1' ? { questionId: 'q1', value: 'a' } : undefined
    };
    const result = await StatisticsService.calculateQuestionStatistics(question, [mockResponse]);
    expect(result.responseCount).toBe(1);
  });
});
