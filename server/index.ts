import express from 'express';
import cors from 'cors'; import helmet from 'helmet'; import compression from 'compression';
import { createServer } from 'http'; import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url'; import { dirname, join } from 'path'; import { existsSync } from 'fs';
import dotenv from 'dotenv'; import { rateLimit } from 'express-rate-limit'; dotenv.config();
import { initSchema } from './db/schema.js'; import { purgeExpiredCheckpoints } from './agent/checkpoint.js';
import authRouter from './routes/auth.js'; import chatRouter from './routes/chat.js'; import predictionsRouter from './routes/predictions.js'; import statsRouter from './routes/stats.js'; import bookingRouter from './routes/booking.js'; import validationRouter from './routes/model-validation.js';
import { requireAuth } from './middleware/auth.js'; import { initTelegram } from './telegram.js'; import { initAirtable } from './agent/airtable-logger.js'; import { initSettlementCron } from './agent/settlement.js'; import { initCalibration } from './agent/calibration.js';
const __filename=fileURLToPath(import.meta.url),__dirname=dirname(__filename),PORT=parseInt(process.env.PORT||process.env.API_PORT||'5000',10),app=express(),httpServer=createServer(app);
app.use(helmet({contentSecurityPolicy:false}));app.use(compression());app.use(cors({origin:true,credentials:true}));app.use(express.json({limit:'2mb'}));app.set('trust proxy',1);
const chatLimiter=rateLimit({windowMs:60000,max:20,standardHeaders:true,legacyHeaders:false,message:{error:'Too many requests. Please wait a minute.'}});
app.use('/api/auth',authRouter);app.use('/api/chat',chatLimiter,requireAuth,chatRouter);app.use('/api/predictions',requireAuth,predictionsRouter);app.use('/api/stats',requireAuth,statsRouter);app.use('/api/booking',requireAuth,bookingRouter);app.use('/api/model-validation',requireAuth,validationRouter);
app.get('/api/health',(_req,res)=>res.json({status:'ok',service:'Odessyus Agent API',version:'2.1.0',timestamp:new Date().toISOString()}));
const distPath=join(__dirname,'..','dist');if(existsSync(distPath)){app.use(express.static(distPath));app.get('*',(_req,res)=>res.sendFile(join(distPath,'index.html')));}
const wss=new WebSocketServer({server:httpServer,path:'/ws'});wss.on('connection',(ws:WebSocket,req)=>{const url=new URL(req.url||'/','http://localhost'),sessionId=url.searchParams.get('session')||'anonymous';console.log(`[WS] Client connected: ${sessionId}`);ws.on('message',data=>{try{const msg=JSON.parse(data.toString()) as{type:string};if(msg.type==='ping')ws.send(JSON.stringify({type:'pong',timestamp:Date.now()}));}catch{}});ws.on('close',()=>console.log(`[WS] Client disconnected: ${sessionId}`));ws.send(JSON.stringify({type:'welcome',message:'Odessyus WebSocket connected'}));});
async function start(){await new Promise<void>(resolve=>httpServer.listen(PORT,'0.0.0.0',()=>{console.log(`[Server] Odessyus API running on port ${PORT}`);resolve();}));try{await initSchema();await initCalibration();purgeExpiredCheckpoints().catch(()=>{});initTelegram();initAirtable().catch(err=>console.error('[Server] Airtable init error:',err instanceof Error?err.message:String(err)));initSettlementCron();}catch(err){console.error('[Server] Startup error:',err);}}
start();export default app;
