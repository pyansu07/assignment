import { Router } from 'express';
import { accountController } from '../controllers/accountController';
import { transactionController } from '../controllers/transactionController';
import { transferController } from '../controllers/transferController';
import { asyncHandler } from '../utils/asyncHandler';

// Deliberately no PUT/PATCH/DELETE routes: ledger entries are immutable through the API.
export const router = Router();

router.post('/accounts', asyncHandler(accountController.create));
router.get('/accounts/:accountId/balance', asyncHandler(accountController.getBalance));
router.post('/accounts/:accountId/transactions', asyncHandler(transactionController.create));
router.get('/accounts/:accountId/transactions', asyncHandler(transactionController.list));
router.post('/transfers', asyncHandler(transferController.create));
