const { Survey } = require('../models/Survey');
const Response = require('../models/Response');
const StatisticsService = require('../services/statisticsService');
const { QUESTION_TYPES } = require('../models/Question');

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
    
    const comparisonSummary = buildVersionComparisonSummary(versionStats, survey);
    
    res.json({
      success: true,
      data: {
        mode: 'all_versions',
        currentVersion: survey.version,
        versionDistribution,
        versions: versionStats,
        comparisonSummary,
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

function buildVersionComparisonSummary(versionStats, survey) {
  if (!versionStats || versionStats.length < 1) {
    return null;
  }
  
  const sortedVersions = [...versionStats].sort((a, b) => a.version - b.version);
  
  const perVersion = sortedVersions.map(vs => {
    const questions = vs.version === survey.version
      ? survey.questions
      : (survey.history.find(h => h.version === vs.version)?.questions || survey.questions);
    
    const ratingQuestions = questions.filter(q => q.type === QUESTION_TYPES.RATING);
    const singleChoiceQuestions = questions.filter(q => q.type === QUESTION_TYPES.SINGLE_CHOICE);
    
    const ratingMeans = ratingQuestions.map(q => {
      const qStats = vs.statistics.questions.find(s => s.questionId === q.id);
      return {
        questionId: q.id,
        title: q.title,
        mean: qStats?.statistics?.mean ?? null
      };
    });
    
    const topChoices = singleChoiceQuestions.map(q => {
      const qStats = vs.statistics.questions.find(s => s.questionId === q.id);
      const mode = qStats?.statistics?.mode;
      const maxCount = Math.max(...(Object.values(qStats?.statistics?.distribution || {})), 0);
      return {
        questionId: q.id,
        title: q.title,
        topOptionValue: mode?.value ?? null,
        topOptionLabel: mode?.label ?? null,
        topOptionCount: maxCount,
        topOptionPercentage: qStats?.statistics?.options?.find(o => o.value === mode?.value)?.percentage ?? 0
      };
    });
    
    return {
      version: vs.version,
      isCurrent: vs.isCurrent,
      responseCount: vs.responseCount,
      ratingMeans,
      topChoices
    };
  });
  
  const changes = [];
  
  if (perVersion.length >= 2) {
    for (let i = 1; i < perVersion.length; i++) {
      const prev = perVersion[i - 1];
      const curr = perVersion[i];
      const diff = {
        fromVersion: prev.version,
        toVersion: curr.version,
        responseCountChange: {
          before: prev.responseCount,
          after: curr.responseCount,
          delta: curr.responseCount - prev.responseCount,
          deltaPercent: prev.responseCount > 0 
            ? Math.round(((curr.responseCount - prev.responseCount) / prev.responseCount) * 10000) / 100
            : null
        },
        ratingMeanChanges: [],
        topChoiceChanges: []
      };
      
      for (const prevRating of prev.ratingMeans) {
        const currRating = curr.ratingMeans.find(r => r.questionId === prevRating.questionId);
        if (currRating && prevRating.mean !== null && currRating.mean !== null) {
          diff.ratingMeanChanges.push({
            questionId: prevRating.questionId,
            title: prevRating.title,
            before: prevRating.mean,
            after: currRating.mean,
            delta: Math.round((currRating.mean - prevRating.mean) * 100) / 100
          });
        }
      }
      
      for (const prevChoice of prev.topChoices) {
        const currChoice = curr.topChoices.find(c => c.questionId === prevChoice.questionId);
        if (currChoice) {
          diff.topChoiceChanges.push({
            questionId: prevChoice.questionId,
            title: prevChoice.title,
            changed: prevChoice.topOptionValue !== currChoice.topOptionValue,
            before: { value: prevChoice.topOptionValue, label: prevChoice.topOptionLabel, count: prevChoice.topOptionCount, percentage: prevChoice.topOptionPercentage },
            after: { value: currChoice.topOptionValue, label: currChoice.topOptionLabel, count: currChoice.topOptionCount, percentage: currChoice.topOptionPercentage }
          });
        }
      }
      
      changes.push(diff);
    }
  }
  
  return {
    perVersion,
    changes,
    currentRank: sortedVersions.map(vs => ({
      version: vs.version,
      responseCount: vs.responseCount
    }))
  };
}

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
    const { 
      version,
      userId,
      ipAddress,
      deviceId,
      fingerprint,
      startDate,
      endDate
    } = req.query;
    
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
    
    const filters = {
      version: version !== undefined ? version : null,
      userId: userId || null,
      ipAddress: ipAddress || null,
      deviceId: deviceId || null,
      fingerprint: fingerprint || null,
      startDate: startDate || null,
      endDate: endDate || null
    };
    
    const query = Response.buildFilterQuery(surveyId, filters);
    const responses = await Response.find(query).sort({ createdAt: -1 }).lean();
    
    const targetVersion = version ? Number(version) : null;
    const csvContent = StatisticsService.exportToCSV(survey, responses, targetVersion);
    
    const filterSuffix = [
      version ? `v${version}` : null,
      userId ? `user-${userId}` : null,
      ipAddress ? `ip-${ipAddress.replace(/\./g, '-')}` : null
    ].filter(Boolean).join('_');
    
    const filename = `survey-${surveyId}-${filterSuffix || 'filtered'}-${Date.now()}.csv`;
    
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
