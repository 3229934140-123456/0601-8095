const express = require('express');
const router = express.Router();
const surveyController = require('../controllers/surveyController');
const { auth, optionalAuth } = require('../middleware/auth');

router.post('/', auth, surveyController.createSurvey);
router.get('/', auth, surveyController.getSurveyList);
router.get('/:id', optionalAuth, surveyController.getSurvey);
router.get('/:id/entry', optionalAuth, surveyController.getFillEntry);
router.get('/:id/versions', auth, surveyController.getSurveyVersions);
router.put('/:id', auth, surveyController.updateSurvey);
router.put('/:id/status', auth, surveyController.updateSurveyStatus);
router.delete('/:id', auth, surveyController.deleteSurvey);

router.get('/:id/invites', auth, surveyController.getInviteList);
router.get('/:id/invites/stats', auth, surveyController.getInviteStats);
router.post('/:id/invites/batch', auth, surveyController.batchCreateInvites);
router.post('/:id/invites/:inviteId/revoke', auth, surveyController.revokeInvite);
router.get('/:id/invites/verify', optionalAuth, surveyController.verifyInvite);

module.exports = router;
