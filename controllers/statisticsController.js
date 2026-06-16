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
  const emptyPerVersion = {
    version: 0,
    isCurrent: false,
    responseCount: 0,
    hasResponses: false,
    title: '',
    createdAt: null,
    questionCount: { total: 0, rating: 0, singleChoice: 0, multipleChoice: 0 },
    ratingMeans: [],
    topChoices: []
  };

  const result = {
    perVersion: [],
    changes: [],
    currentRank: [],
    questionChanges: { added: 0, removed: 0, titleChanged: 0, typeChanged: 0 },
    meta: {
      totalVersions: 0,
      hasMultipleVersions: false,
      hasEmptyVersions: false
    }
  };

  if (!versionStats || versionStats.length === 0) {
    return result;
  }

  const safeGet = (obj, path, defaultValue = null) => {
    try {
      return path.split('.').reduce((o, key) => (o && o[key] !== undefined ? o[key] : defaultValue), obj);
    } catch (e) {
      return defaultValue;
    }
  };

  const sortedVersions = [...versionStats].sort((a, b) => a.version - b.version);

  const perVersion = sortedVersions.map(vs => {
    let questions = [];
    try {
      questions = vs.version === survey.version
        ? (survey.questions || [])
        : (survey.history?.find(h => h.version === vs.version)?.questions || survey.questions || []);
    } catch (e) {
      questions = [];
    }

    const ratingQuestions = Array.isArray(questions)
      ? questions.filter(q => q && q.type === QUESTION_TYPES.RATING)
      : [];
    const singleChoiceQuestions = Array.isArray(questions)
      ? questions.filter(q => q && q.type === QUESTION_TYPES.SINGLE_CHOICE)
      : [];
    const multipleChoiceQuestions = Array.isArray(questions)
      ? questions.filter(q => q && q.type === QUESTION_TYPES.MULTIPLE_CHOICE)
      : [];

    const statsQuestionsRaw = safeGet(vs, 'statistics.questions', {});
    const statsQuestions = statsQuestionsRaw && typeof statsQuestionsRaw === 'object' && !Array.isArray(statsQuestionsRaw)
      ? Object.values(statsQuestionsRaw)
      : (Array.isArray(statsQuestionsRaw) ? statsQuestionsRaw : []);

    const ratingMeans = ratingQuestions.map(q => {
      const qStats = statsQuestions.find(s => s && s.questionId === q.id);
      const mean = safeGet(qStats, 'mean', null);
      const count = safeGet(qStats, 'responseCount', 0);
      return {
        questionId: q.id,
        title: q.title || `题目 ${q.id}`,
        order: q.order ?? 999,
        mean: typeof mean === 'number' ? mean : null,
        responseCount: typeof count === 'number' ? count : 0
      };
    });

    const buildTopChoice = (q) => {
      const qStats = statsQuestions.find(s => s && s.questionId === q.id);
      const options = safeGet(qStats, 'options', []) || [];
      const mode = safeGet(qStats, 'mode', null);
      const totalResponses = safeGet(qStats, 'responseCount', 0) || 0;

      let topOption = null;
      let topCount = 0;
      let topPercentage = 0;

      if (mode && typeof mode === 'object') {
        topOption = { value: mode.value, label: mode.label };
        topCount = typeof mode.count === 'number' ? mode.count : 0;
        if (totalResponses > 0) {
          topPercentage = Math.round((topCount / totalResponses) * 10000) / 100;
        }
      } else if (options.length > 0) {
        const sorted = [...options].sort((a, b) => (b.count || 0) - (a.count || 0));
        if (sorted[0]) {
          topOption = { value: sorted[0].value, label: sorted[0].label };
          topCount = sorted[0].count || 0;
          topPercentage = sorted[0].percentage || 0;
        }
      }

      return {
        questionId: q.id,
        title: q.title || `题目 ${q.id}`,
        order: q.order ?? 999,
        questionType: q.type,
        topOptionValue: topOption ? topOption.value : null,
        topOptionLabel: topOption ? topOption.label : null,
        topOptionCount: topCount,
        topOptionPercentage,
        responseCount: totalResponses
      };
    };

    const topSingleChoices = singleChoiceQuestions.map(buildTopChoice);
    const topMultipleChoices = multipleChoiceQuestions.map(buildTopChoice);
    const topChoices = [...topSingleChoices, ...topMultipleChoices].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

    const hasResponses = (vs.responseCount || 0) > 0;

    return {
      version: vs.version,
      isCurrent: !!vs.isCurrent,
      responseCount: vs.responseCount || 0,
      hasResponses,
      title: vs.title || `版本 ${vs.version}`,
      createdAt: vs.createdAt || null,
      questionCount: {
        total: questions.length,
        rating: ratingQuestions.length,
        singleChoice: singleChoiceQuestions.length,
        multipleChoice: multipleChoiceQuestions.length
      },
      ratingMeans,
      topChoices
    };
  });

  const changes = [];

  for (let i = 1; i < perVersion.length; i++) {
    const prev = perVersion[i - 1];
    const curr = perVersion[i];

    const prevCount = prev.responseCount || 0;
    const currCount = curr.responseCount || 0;

    const diff = {
      fromVersion: prev.version,
      fromTitle: prev.title,
      toVersion: curr.version,
      toTitle: curr.title,
      responseCountChange: {
        before: prevCount,
        after: currCount,
        delta: currCount - prevCount,
        deltaPercent: prevCount > 0
          ? Math.round(((currCount - prevCount) / prevCount) * 10000) / 100
          : (currCount > 0 ? 100 : 0)
      },
      questionChanges: {
        added: 0,
        removed: 0,
        titleChanged: 0,
        typeChanged: 0
      },
      ratingMeanChanges: [],
      topChoiceChanges: []
    };

    const prevQids = new Set([...prev.ratingMeans.map(r => r.questionId), ...prev.topChoices.map(t => t.questionId)]);
    const currQids = new Set([...curr.ratingMeans.map(r => r.questionId), ...curr.topChoices.map(t => t.questionId)]);
    const allQids = new Set([...prevQids, ...currQids]);

    for (const qid of allQids) {
      const inPrev = prevQids.has(qid);
      const inCurr = currQids.has(qid);
      if (inPrev && !inCurr) diff.questionChanges.removed++;
      if (!inPrev && inCurr) diff.questionChanges.added++;
    }

    for (const prevRating of prev.ratingMeans) {
      const currRating = curr.ratingMeans.find(r => r.questionId === prevRating.questionId);
      if (currRating) {
        if (prevRating.title !== currRating.title) {
          diff.questionChanges.titleChanged++;
        }

        const prevMean = typeof prevRating.mean === 'number' ? prevRating.mean : null;
        const currMean = typeof currRating.mean === 'number' ? currRating.mean : null;

        diff.ratingMeanChanges.push({
          questionId: prevRating.questionId,
          title: currRating.title,
          before: prevMean,
          after: currMean,
          delta: (prevMean !== null && currMean !== null)
            ? Math.round((currMean - prevMean) * 100) / 100
            : null,
          status: (prevMean === currMean || (prevMean === null && currMean === null)) ? 'unchanged' : 'changed'
        });
      }
    }

    for (const prevChoice of prev.topChoices) {
      const currChoice = curr.topChoices.find(c => c.questionId === prevChoice.questionId);
      if (currChoice) {
        if (prevChoice.title !== currChoice.title) diff.questionChanges.titleChanged++;
        if (prevChoice.questionType !== currChoice.questionType) diff.questionChanges.typeChanged++;

        const changed = prevChoice.topOptionValue !== currChoice.topOptionValue;
        diff.topChoiceChanges.push({
          questionId: prevChoice.questionId,
          title: currChoice.title,
          questionType: currChoice.questionType,
          changed,
          status: changed ? 'changed' : 'unchanged',
          before: {
            value: prevChoice.topOptionValue,
            label: prevChoice.topOptionLabel,
            count: prevChoice.topOptionCount,
            percentage: prevChoice.topOptionPercentage,
            responseCount: prevChoice.responseCount
          },
          after: {
            value: currChoice.topOptionValue,
            label: currChoice.topOptionLabel,
            count: currChoice.topOptionCount,
            percentage: currChoice.topOptionPercentage,
            responseCount: currChoice.responseCount
          }
        });
      }
    }

    changes.push(diff);
  }

  const totalAdded = changes.reduce((s, c) => s + c.questionChanges.added, 0);
  const totalRemoved = changes.reduce((s, c) => s + c.questionChanges.removed, 0);
  const totalTitleChanged = changes.reduce((s, c) => s + c.questionChanges.titleChanged, 0);
  const totalTypeChanged = changes.reduce((s, c) => s + c.questionChanges.typeChanged, 0);

  result.perVersion = perVersion;
  result.changes = changes;
  result.currentRank = perVersion
    .slice()
    .sort((a, b) => b.responseCount - a.responseCount)
    .map(vs => ({
      version: vs.version,
      isCurrent: vs.isCurrent,
      title: vs.title,
      responseCount: vs.responseCount
    }));
  result.questionChanges = {
    added: totalAdded,
    removed: totalRemoved,
    titleChanged: totalTitleChanged,
    typeChanged: totalTypeChanged
  };
  result.meta = {
    totalVersions: perVersion.length,
    hasMultipleVersions: perVersion.length >= 2,
    hasEmptyVersions: perVersion.some(v => !v.hasResponses)
  };

  return result;
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
      endDate,
      riskLevel,
      riskFlag,
      riskFlags,
      completionTimeMin,
      completionTimeMax
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
      endDate: endDate || null,
      riskLevel: riskLevel || null,
      riskFlag: riskFlag || null,
      riskFlags: riskFlags ? (Array.isArray(riskFlags) ? riskFlags : [riskFlags]) : null,
      completionTimeMin: completionTimeMin !== undefined ? completionTimeMin : null,
      completionTimeMax: completionTimeMax !== undefined ? completionTimeMax : null
    };
    
    const query = Response.buildFilterQuery(surveyId, filters);
    const responses = await Response.find(query).sort({ createdAt: -1 }).lean();
    
    const targetVersion = version ? Number(version) : null;
    const csvContent = StatisticsService.exportToCSV(survey, responses, targetVersion, filters);
    
    const filterSuffix = [
      version ? `v${version}` : null,
      userId ? `user-${userId}` : null,
      ipAddress ? `ip-${ipAddress.replace(/\./g, '-')}` : null,
      riskLevel ? `risk-${riskLevel}` : null,
      riskFlag ? `flag-${riskFlag}` : null
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
