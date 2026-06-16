const { Survey } = require('../models/Survey');
const Response = require('../models/Response');
const StatisticsService = require('../services/statisticsService');

exports.getStatistics = async (req, res, next) => {
  try {
    const { surveyId } = req.params;
    const { version } = req.query;
    
    const survey = await Survey.getFullSurvey(surveyId);
    
    if (!survey) {
      return res.status(404).json({
        success: false,
        message: '问卷不存在'
      });
    }
    
    if (survey.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: '无权限查看此问卷的统计数据'
      });
    }
    
    const targetVersion = version ? Number(version) : null;
    const allResponses = await Response.getResponsesBySurveyVersion(surveyId, null);
    const versionDistribution = await Response.getResponseCountByVersion(surveyId);
    
    if (targetVersion !== null) {
      const versionResponses = allResponses.filter(r => r.surveyVersion === targetVersion);
      const statistics = await StatisticsService.calculateStatistics(
        survey,
        versionResponses,
        targetVersion
      );
      
      return res.json({
        success: true,
        data: {
          mode: 'single_version',
          statistics
        }
      });
    }
    
    const versionStats = [];
    const versionsWithResponses = new Set(versionDistribution.map(v => v._id));
    versionsWithResponses.add(survey.version);
    
    for (const v of [...versionsWithResponses].sort((a, b) => b - a)) {
      const versionResponses = allResponses.filter(r => r.surveyVersion === v);
      if (versionResponses.length === 0 && v !== survey.version) continue;
      
      const stats = await StatisticsService.calculateStatistics(
        survey,
        versionResponses,
        v
      );
      
      const versionInfo = v === survey.version 
        ? { version: v, isCurrent: true, title: survey.title, description: survey.description, createdAt: survey.updatedAt }
        : survey.history.find(h => h.version === v) || { version: v, isCurrent: false, title: `版本 ${v}`, description: '', createdAt: null };
      
      versionStats.push({
        version: v,
        isCurrent: v === survey.version,
        title: versionInfo.title,
        description: versionInfo.description,
        createdAt: versionInfo.createdAt,
        responseCount: versionResponses.length,
        statistics: stats
      });
    }
    
    res.json({
      success: true,
      data: {
        mode: 'all_versions',
        currentVersion: survey.version,
        versionDistribution,
        versions: versionStats,
        summary: {
          totalResponses: allResponses.length,
          totalVersions: versionStats.length
        }
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.getQuestionStatistics = async (req, res, next) => {
  try {
    const { surveyId, questionId } = req.params;
    const { version } = req.query;
    
    const survey = await Survey.getFullSurvey(surveyId);
    
    if (!survey) {
      return res.status(404).json({
        success: false,
        message: '问卷不存在'
      });
    }
    
    if (survey.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: '无权限查看此问卷的统计数据'
      });
    }
    
    const targetVersion = version ? Number(version) : null;
    const questions = targetVersion
      ? survey.history.find(h => h.version === targetVersion)?.questions || survey.questions
      : survey.questions;
    
    const question = questions.find(q => q.id === questionId);
    
    if (!question) {
      return res.status(404).json({
        success: false,
        message: '题目不存在'
      });
    }
    
    const responses = await Response.getResponsesBySurveyVersion(surveyId, targetVersion);
    const statistics = await StatisticsService.calculateQuestionStatistics(
      question,
      responses
    );
    
    res.json({
      success: true,
      data: {
        statistics
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.exportCSV = async (req, res, next) => {
  try {
    const { surveyId } = req.params;
    const { version } = req.query;
    
    const survey = await Survey.getFullSurvey(surveyId);
    
    if (!survey) {
      return res.status(404).json({
        success: false,
        message: '问卷不存在'
      });
    }
    
    if (survey.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: '无权限导出此问卷的数据'
      });
    }
    
    const targetVersion = version ? Number(version) : null;
    const responses = await Response.getResponsesBySurveyVersion(surveyId, targetVersion);
    
    const csvContent = StatisticsService.exportToCSV(survey, responses, targetVersion);
    
    const filename = `survey-${surveyId}-${targetVersion || 'all'}-${Date.now()}.csv`;
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', Buffer.byteLength(csvContent, 'utf8'));
    
    res.write('\uFEFF');
    res.write(csvContent);
    res.end();
  } catch (err) {
    next(err);
  }
};

exports.getResponseTrend = async (req, res, next) => {
  try {
    const { surveyId } = req.params;
    const { granularity = 'day', startDate, endDate } = req.query;
    
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
        message: '无权限查看此问卷的统计数据'
      });
    }
    
    const match = { surveyId };
    
    if (startDate) {
      match.createdAt = match.createdAt || {};
      match.createdAt.$gte = new Date(startDate);
    }
    
    if (endDate) {
      match.createdAt = match.createdAt || {};
      match.createdAt.$lte = new Date(endDate);
    }
    
    let groupId;
    switch (granularity) {
      case 'hour':
        groupId = {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          day: { $dayOfMonth: '$createdAt' },
          hour: { $hour: '$createdAt' }
        };
        break;
      case 'week':
        groupId = {
          year: { $year: '$createdAt' },
          week: { $week: '$createdAt' }
        };
        break;
      case 'month':
        groupId = {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' }
        };
        break;
      case 'day':
      default:
        groupId = {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          day: { $dayOfMonth: '$createdAt' }
        };
    }
    
    const trend = await Response.aggregate([
      { $match: match },
      {
        $group: {
          _id: groupId,
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1 } }
    ]);
    
    const formattedTrend = trend.map(item => {
      const dateParts = item._id;
      let date;
      if (dateParts.hour !== undefined) {
        date = new Date(dateParts.year, dateParts.month - 1, dateParts.day, dateParts.hour);
      } else if (dateParts.week !== undefined) {
        date = new Date(dateParts.year, 0, 1 + (dateParts.week - 1) * 7);
      } else if (dateParts.day !== undefined) {
        date = new Date(dateParts.year, dateParts.month - 1, dateParts.day);
      } else {
        date = new Date(dateParts.year, dateParts.month - 1, 1);
      }
      
      return {
        date: date.toISOString(),
        count: item.count
      };
    });
    
    res.json({
      success: true,
      data: {
        trend: formattedTrend,
        granularity,
        totalResponses: formattedTrend.reduce((sum, item) => sum + item.count, 0)
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.getVersionComparison = async (req, res, next) => {
  try {
    const { surveyId } = req.params;
    
    const survey = await Survey.getFullSurvey(surveyId);
    
    if (!survey) {
      return res.status(404).json({
        success: false,
        message: '问卷不存在'
      });
    }
    
    if (survey.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: '无权限查看此问卷的统计数据'
      });
    }
    
    const versionDistribution = await Response.getResponseCountByVersion(surveyId);
    
    const versionStats = [];
    
    for (const versionInfo of versionDistribution) {
      const version = versionInfo._id;
      const responses = await Response.getResponsesBySurveyVersion(surveyId, version);
      const stats = await StatisticsService.calculateStatistics(survey, responses, version);
      
      versionStats.push({
        version,
        responseCount: versionInfo.count,
        statistics: stats
      });
    }
    
    res.json({
      success: true,
      data: {
        versions: versionStats,
        currentVersion: survey.version
      }
    });
  } catch (err) {
    next(err);
  }
};
