const { QUESTION_TYPES } = require('../models/Question');

class StatisticsService {
  static async calculateStatistics(survey, responses, version = null) {
    const questions = version
      ? survey.history.find(h => h.version === version)?.questions || survey.questions
      : survey.questions;

    const versionResponses = version
      ? responses.filter(r => r.surveyVersion === version)
      : responses;

    const questionStats = {};
    const totalResponses = versionResponses.length;

    for (const question of questions) {
      questionStats[question.id] = await this.calculateQuestionStatistics(
        question,
        versionResponses
      );
    }

    const versionStats = await this.getVersionDistribution(survey.id);

    return {
      surveyId: survey.id,
      surveyVersion: version || survey.version,
      totalResponses,
      versionDistribution: versionStats,
      questions: questionStats,
      metadata: {
        calculatedAt: new Date(),
        timeRange: this.calculateTimeRange(versionResponses)
      }
    };
  }

  static async calculateQuestionStatistics(question, responses) {
    const answers = responses
      .map(r => r.getAnswerByQuestionId(question.id))
      .filter(a => a !== undefined && a.value !== null && a.value !== '');

    const responseCount = answers.length;
    const skipCount = responses.length - responseCount;

    let stats = {
      questionId: question.id,
      questionType: question.type,
      questionTitle: question.title,
      responseCount,
      skipCount,
      responseRate: responses.length > 0 
        ? Math.round((responseCount / responses.length) * 10000) / 100
        : 0
    };

    switch (question.type) {
      case QUESTION_TYPES.SINGLE_CHOICE:
        stats = { ...stats, ...this.calculateSingleChoiceStats(question, answers) };
        break;
      case QUESTION_TYPES.MULTIPLE_CHOICE:
        stats = { ...stats, ...this.calculateMultipleChoiceStats(question, answers) };
        break;
      case QUESTION_TYPES.RATING:
        stats = { ...stats, ...this.calculateRatingStats(question, answers) };
        break;
      case QUESTION_TYPES.TEXT:
        stats = { ...stats, ...this.calculateTextStats(question, answers) };
        break;
    }

    return stats;
  }

  static calculateSingleChoiceStats(question, answers) {
    const distribution = {};
    const optionLabels = {};

    for (const option of question.config.options) {
      distribution[option.value] = 0;
      optionLabels[option.value] = option.label;
    }

    for (const answer of answers) {
      if (distribution[answer.value] !== undefined) {
        distribution[answer.value]++;
      }
    }

    const options = question.config.options.map(option => ({
      value: option.value,
      label: option.label,
      count: distribution[option.value],
      percentage: answers.length > 0
        ? Math.round((distribution[option.value] / answers.length) * 10000) / 100
        : 0
    }));

    const maxCount = Math.max(...Object.values(distribution));
    const mode = Object.keys(distribution).find(k => distribution[k] === maxCount);

    return {
      distribution,
      optionLabels,
      options,
      mode: mode ? { value: mode, label: optionLabels[mode], count: maxCount } : null
    };
  }

  static calculateMultipleChoiceStats(question, answers) {
    const distribution = {};
    const optionLabels = {};
    const selectionCounts = [];

    for (const option of question.config.options) {
      distribution[option.value] = 0;
      optionLabels[option.value] = option.label;
    }

    for (const answer of answers) {
      if (Array.isArray(answer.value)) {
        const uniqueValues = [...new Set(answer.value)];
        selectionCounts.push(uniqueValues.length);
        for (const value of uniqueValues) {
          if (distribution[value] !== undefined) {
            distribution[value]++;
          }
        }
      }
    }

    const totalSelections = Object.values(distribution).reduce((a, b) => a + b, 0);
    const avgSelections = answers.length > 0
      ? Math.round((totalSelections / answers.length) * 100) / 100
      : 0;

    const options = question.config.options.map(option => ({
      value: option.value,
      label: option.label,
      count: distribution[option.value],
      percentage: answers.length > 0
        ? Math.round((distribution[option.value] / answers.length) * 10000) / 100
        : 0
    }));

    return {
      distribution,
      optionLabels,
      options,
      totalSelections,
      averageSelections: avgSelections,
      selectionCountDistribution: this.calculateFrequency(selectionCounts)
    };
  }

  static calculateRatingStats(question, answers) {
    const values = answers
      .map(a => a.value)
      .filter(v => typeof v === 'number' && !isNaN(v));

    if (values.length === 0) {
      return {
        mean: null,
        median: null,
        mode: null,
        min: null,
        max: null,
        stdDev: null,
        distribution: {},
        quartiles: null
      };
    }

    values.sort((a, b) => a - b);

    const sum = values.reduce((a, b) => a + b, 0);
    const mean = Math.round((sum / values.length) * 100) / 100;

    const mid = Math.floor(values.length / 2);
    const median = values.length % 2 !== 0
      ? values[mid]
      : Math.round(((values[mid - 1] + values[mid]) / 2) * 100) / 100;

    const frequency = {};
    let maxFreq = 0;
    let mode = values[0];

    for (const val of values) {
      frequency[val] = (frequency[val] || 0) + 1;
      if (frequency[val] > maxFreq) {
        maxFreq = frequency[val];
        mode = val;
      }
    }

    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.round(Math.sqrt(variance) * 100) / 100;

    const distribution = {};
    let current = question.config.min;
    while (current <= question.config.max) {
      distribution[current] = frequency[current] || 0;
      current += question.config.step;
    }

    const distributionArray = Object.entries(distribution).map(([value, count]) => ({
      value: Number(value),
      count,
      percentage: Math.round((count / values.length) * 10000) / 100
    }));

    return {
      mean,
      median,
      mode,
      min: values[0],
      max: values[values.length - 1],
      stdDev,
      distribution,
      distributionArray,
      quartiles: {
        q1: this.percentile(values, 25),
        q2: median,
        q3: this.percentile(values, 75)
      }
    };
  }

  static calculateTextStats(question, answers) {
    const texts = answers
      .map(a => a.value)
      .filter(v => typeof v === 'string' && v.trim().length > 0);

    const lengths = texts.map(t => t.length);
    const avgLength = lengths.length > 0
      ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)
      : 0;

    const wordCounts = texts.map(t => t.trim().split(/\s+/).length);
    const avgWords = wordCounts.length > 0
      ? Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length)
      : 0;

    const sampleCount = Math.min(10, texts.length);
    const samples = texts.slice(0, sampleCount);

    return {
      averageLength: avgLength,
      averageWords: avgWords,
      maxLength: lengths.length > 0 ? Math.max(...lengths) : 0,
      minLength: lengths.length > 0 ? Math.min(...lengths) : 0,
      samples,
      sampleCount,
      totalTextCount: texts.length,
      lengthDistribution: this.calculateFrequency(
        lengths.map(l => Math.floor(l / 50) * 50)
      )
    };
  }

  static async getVersionDistribution(surveyId) {
    const Response = require('../models/Response');
    return await Response.getResponseCountByVersion(surveyId);
  }

  static percentile(sortedArray, percentile) {
    if (sortedArray.length === 0) return null;
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    return sortedArray[Math.max(0, index)];
  }

  static calculateFrequency(arr) {
    const freq = {};
    for (const val of arr) {
      freq[val] = (freq[val] || 0) + 1;
    }
    return freq;
  }

  static calculateTimeRange(responses) {
    if (responses.length === 0) {
      return { start: null, end: null };
    }

    const timestamps = responses.map(r => new Date(r.createdAt).getTime());
    return {
      start: new Date(Math.min(...timestamps)),
      end: new Date(Math.max(...timestamps))
    };
  }

  static exportToCSV(survey, responses, version = null) {
    const questions = version
      ? survey.history.find(h => h.version === version)?.questions || survey.questions
      : survey.questions;

    const headers = ['回答ID', '提交时间', '用户ID', 'IP地址', ...questions.map(q => q.title)];
    
    const rows = responses.map(response => {
      const row = [
        response.id,
        response.createdAt.toISOString(),
        response.respondent.userId || '匿名',
        response.respondent.ipAddress
      ];

      for (const question of questions) {
        const answer = response.getAnswerByQuestionId(question.id);
        if (!answer) {
          row.push('');
        } else if (Array.isArray(answer.value)) {
          row.push(answer.value.join('; '));
        } else {
          row.push(String(answer.value));
        }
      }

      return row;
    });

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    return csvContent;
  }
}

module.exports = StatisticsService;
