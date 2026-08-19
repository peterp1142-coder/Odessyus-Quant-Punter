import { Router, Request, Response } from 'express';
import { backtestAll, backtestMarket } from '../agent/backtest.js';
import { getCalibrationReport, recalibrateMarket } from '../agent/calibration.js';
const router=Router();
router.get('/calibration',async(_req:Request,res:Response)=>{try{res.json({calibration:await getCalibrationReport()});}catch(e){res.status(500).json({error:e instanceof Error?e.message:String(e)});}});
router.post('/calibrate',async(req:Request,res:Response)=>{try{const market=String(req.body?.market||'');if(!market)return res.status(400).json({error:'market required'});const result=await recalibrateMarket(market);res.json({result});}catch(e){res.status(500).json({error:e instanceof Error?e.message:String(e)});}});
router.get('/backtest',async(_req:Request,res:Response)=>{try{res.json({reports:await backtestAll()});}catch(e){res.status(500).json({error:e instanceof Error?e.message:String(e)});}});
router.get('/backtest/:market',async(req:Request,res:Response)=>{try{res.json({report:await backtestMarket(req.params.market)});}catch(e){res.status(500).json({error:e instanceof Error?e.message:String(e)});}});
export default router;
