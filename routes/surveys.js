const express = require('express');
const router = express.Router();
const surveyController = require('../controllers/surveyController');
const { auth, optionalAuth } = require('../middleware/auth');

router.post('/', auth, surveyController.createSurvey);
router.get('/', auth, surveyController.getSurveyList);
router.get('/:id', optionalAuth, surveyController.getSurvey);
router.get('/:id/versions', auth, surveyController.getSurveyVersions);
router.put('/:id', auth, surveyController.updateSurvey);
router.put('/:id/status', auth, surveyController.updateSurveyStatus);
router.delete('/:id', auth, surveyController.deleteSurvey);

module.exports = router;
