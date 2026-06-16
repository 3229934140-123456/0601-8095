const express = require('express');
const router = express.Router();
const statisticsController = require('../controllers/statisticsController');
const { auth } = require('../middleware/auth');

router.get('/survey/:surveyId', auth, statisticsController.getStatistics);
router.get('/survey/:surveyId/question/:questionId', auth, statisticsController.getQuestionStatistics);
router.get('/survey/:surveyId/export', auth, statisticsController.exportCSV);
router.get('/survey/:surveyId/trend', auth, statisticsController.getResponseTrend);
router.get('/survey/:surveyId/version-comparison', auth, statisticsController.getVersionComparison);

module.exports = router;
