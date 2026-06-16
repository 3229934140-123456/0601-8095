const express = require('express');
const router = express.Router();
const responseController = require('../controllers/responseController');
const { auth, optionalAuth } = require('../middleware/auth');

router.post('/survey/:surveyId', optionalAuth, responseController.submitResponse);
router.get('/survey/:surveyId/check', optionalAuth, responseController.checkCanSubmit);
router.get('/survey/:surveyId', auth, responseController.getResponses);
router.get('/survey/:surveyId/quality', auth, responseController.getQualityAnalysis);
router.get('/:id', auth, responseController.getResponseDetail);
router.delete('/:id', auth, responseController.deleteResponse);

module.exports = router;
