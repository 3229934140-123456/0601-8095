require('dotenv').config();
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const { Survey } = require('../models/Survey');
const Response = require('../models/Response');
const { QUESTION_TYPES } = require('../models/Question');

const sampleSurveyData = {
  title: '用户满意度调查',
  description: '感谢您参与本次调查，您的反馈对我们非常重要！',
  questions: [
    {
      id: 'q1',
      type: QUESTION_TYPES.SINGLE_CHOICE,
      title: '您的性别是？',
      required: true,
      order: 1,
      config: {
        options: [
          { value: 'male', label: '男' },
          { value: 'female', label: '女' },
          { value: 'other', label: '其他' }
        ]
      }
    },
    {
      id: 'q2',
      type: QUESTION_TYPES.SINGLE_CHOICE,
      title: '您的年龄段是？',
      required: true,
      order: 2,
      config: {
        options: [
          { value: 'under18', label: '18岁以下' },
          { value: '18-25', label: '18-25岁' },
          { value: '26-35', label: '26-35岁' },
          { value: '36-45', label: '36-45岁' },
          { value: 'over45', label: '45岁以上' }
        ]
      }
    },
    {
      id: 'q3',
      type: QUESTION_TYPES.MULTIPLE_CHOICE,
      title: '您是通过哪些渠道了解到我们的产品？（可多选）',
      required: true,
      order: 3,
      config: {
        options: [
          { value: 'search', label: '搜索引擎' },
          { value: 'social', label: '社交媒体' },
          { value: 'friend', label: '朋友推荐' },
          { value: 'ad', label: '广告投放' },
          { value: 'other', label: '其他' }
        ]
      },
      validation: {
        minSelect: 1,
        maxSelect: 3
      }
    },
    {
      id: 'q4',
      type: QUESTION_TYPES.RATING,
      title: '您对我们产品的整体满意度如何？',
      required: true,
      order: 4,
      config: {
        min: 1,
        max: 5,
        step: 1,
        labels: {
          '1': '非常不满意',
          '5': '非常满意'
        }
      }
    },
    {
      id: 'q5',
      type: QUESTION_TYPES.RATING,
      title: '您对我们客服服务的评价',
      required: false,
      order: 5,
      config: {
        min: 0,
        max: 10,
        step: 1
      }
    },
    {
      id: 'q6',
      type: QUESTION_TYPES.TEXT,
      title: '您对我们产品有什么建议或意见？',
      required: false,
      order: 6,
      config: {
        multiline: true,
        placeholder: '请输入您的宝贵建议...'
      },
      validation: {
        minLength: 0,
        maxLength: 500
      }
    }
  ],
  antiDuplicate: {
    mode: 'by_ip',
    cookieExpiryHours: 24
  },
  settings: {
    allowAnonymous: true,
    showProgress: true,
    shuffleQuestions: false
  }
};

const generateSampleResponses = (surveyId, surveyVersion, count = 50) => {
  const responses = [];
  const genders = ['male', 'female', 'other'];
  const ages = ['under18', '18-25', '26-35', '36-45', 'over45'];
  const channels = ['search', 'social', 'friend', 'ad', 'other'];
  
  for (let i = 0; i < count; i++) {
    const selectedChannels = [];
    const numChannels = Math.floor(Math.random() * 3) + 1;
    while (selectedChannels.length < numChannels) {
      const channel = channels[Math.floor(Math.random() * channels.length)];
      if (!selectedChannels.includes(channel)) {
        selectedChannels.push(channel);
      }
    }
    
    const answers = [
      {
        questionId: 'q1',
        value: genders[Math.floor(Math.random() * genders.length)],
        questionType: QUESTION_TYPES.SINGLE_CHOICE
      },
      {
        questionId: 'q2',
        value: ages[Math.floor(Math.random() * ages.length)],
        questionType: QUESTION_TYPES.SINGLE_CHOICE
      },
      {
        questionId: 'q3',
        value: selectedChannels,
        questionType: QUESTION_TYPES.MULTIPLE_CHOICE
      },
      {
        questionId: 'q4',
        value: Math.floor(Math.random() * 5) + 1,
        questionType: QUESTION_TYPES.RATING
      },
      {
        questionId: 'q5',
        value: Math.floor(Math.random() * 11),
        questionType: QUESTION_TYPES.RATING
      }
    ];
    
    if (Math.random() > 0.3) {
      answers.push({
        questionId: 'q6',
        value: `这是第${i + 1}条用户反馈，产品使用体验${Math.random() > 0.5 ? '很好' : '还可以'}，希望继续改进。`,
        questionType: QUESTION_TYPES.TEXT
      });
    }
    
    responses.push({
      surveyId,
      surveyVersion,
      answers,
      respondent: {
        userId: null,
        ipAddress: `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
        deviceId: uuidv4(),
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        fingerprint: `fp_${Math.random().toString(36).substr(2, 9)}`
      },
      metadata: {
        startTime: new Date(Date.now() - Math.random() * 300000),
        completionTime: Math.floor(Math.random() * 180) + 30
      },
      createdAt: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000)
    });
  }
  
  return responses;
};

const seedDatabase = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/survey-system');
    console.log('数据库连接成功');
    
    await User.deleteMany({});
    await Survey.deleteMany({});
    await Response.deleteMany({});
    console.log('已清空现有数据');
    
    const testUser = new User({
      username: 'testuser',
      email: 'test@example.com',
      password: 'password123',
      role: 'user'
    });
    await testUser.save();
    console.log('创建测试用户:', testUser.email);
    
    const adminUser = new User({
      username: 'admin',
      email: 'admin@example.com',
      password: 'admin123',
      role: 'admin'
    });
    await adminUser.save();
    console.log('创建管理员用户:', adminUser.email);
    
    const survey = new Survey({
      ...sampleSurveyData,
      createdBy: testUser.id
    });
    await survey.save();
    console.log('创建示例问卷:', survey.title, 'ID:', survey.id);
    
    const responses = generateSampleResponses(survey.id, survey.version, 50);
    await Response.insertMany(responses);
    console.log('创建', responses.length, '条示例回答');
    
    survey.responseCount = responses.length;
    await survey.save();
    
    console.log('\n=== 种子数据创建完成 ===');
    console.log('测试账号: test@example.com / password123');
    console.log('管理员账号: admin@example.com / admin123');
    console.log('问卷ID:', survey.id);
    console.log('========================\n');
    
    process.exit(0);
  } catch (err) {
    console.error('种子数据创建失败:', err);
    process.exit(1);
  }
};

seedDatabase();
