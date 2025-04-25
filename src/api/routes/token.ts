import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { getTokenLiveStatus, getCredit, tokenSplit } from '@/api/controllers/core.ts';
import logger from '@/lib/logger.ts';
import TokenManager from '@/lib/token/TokenManager.ts';

export default {

    prefix: '/token',

    post: {

        '/check': async (request: Request) => {
            request
                .validate('body.token', _.isString)
            const live = await getTokenLiveStatus(request.body.token);
            return {
                live
            }
        },

        '/points': async (request: Request) => {
            request
                .validate('headers.authorization', _.isString)
            // refresh_token切分
            const tokens = tokenSplit(request.headers.authorization);
            
            // 初始化令牌管理器
            const tokenManager = TokenManager.getInstance();
            await tokenManager.initializeTokens(tokens);
            
            // 获取令牌统计信息
            const tokenStats = tokenManager.getTokenStats();
            
            // 获取积分信息
            const points = await Promise.all(tokens.map(async (token) => {
                const stats = tokenStats.find(stat => stat.token === token);
                return {
                    token,
                    points: await getCredit(token),
                    stats: stats ? {
                        totalCalls: stats.totalCalls,
                        successCalls: stats.successCalls,
                        successRate: stats.totalCalls > 0 ? 
                            (stats.successCalls / stats.totalCalls * 100).toFixed(2) + '%' : 
                            'N/A',
                        lastUsed: stats.lastUsed ? new Date(stats.lastUsed).toISOString() : 'N/A'
                    } : null
                }
            }))
            return points;
        },

        '/stats': async (request: Request) => {
            request
                .validate('headers.authorization', _.isString)
            
            // refresh_token切分
            const tokens = tokenSplit(request.headers.authorization);
            
            // 初始化令牌管理器
            const tokenManager = TokenManager.getInstance();
            await tokenManager.initializeTokens(tokens);
            
            // 获取令牌统计信息
            const tokenStats = tokenManager.getTokenStats();
            
            // 计算一些统计数据
            const stats = tokenStats.map(stat => {
                const successRate = stat.totalCalls > 0 ? 
                    (stat.successCalls / stat.totalCalls * 100).toFixed(2) + '%' : 
                    'N/A';
                
                const pointsInfo = stat.points ? {
                    giftCredit: stat.points.giftCredit,
                    purchaseCredit: stat.points.purchaseCredit,
                    vipCredit: stat.points.vipCredit,
                    totalCredit: stat.points.totalCredit,
                    isAvailable: stat.points.totalCredit >= 1
                } : { isAvailable: false };
                
                return {
                    token: stat.token.substring(0, 10) + '...',
                    points: pointsInfo,
                    usage: {
                        totalCalls: stat.totalCalls,
                        successCalls: stat.successCalls,
                        successRate: successRate,
                        lastUsed: stat.lastUsed ? new Date(stat.lastUsed).toISOString() : 'N/A'
                    }
                };
            });
            
            // 计算总体统计
            const totalCalls = tokenStats.reduce((sum, stat) => sum + stat.totalCalls, 0);
            const totalSuccessCalls = tokenStats.reduce((sum, stat) => sum + stat.successCalls, 0);
            const overallSuccessRate = totalCalls > 0 ? 
                (totalSuccessCalls / totalCalls * 100).toFixed(2) + '%' : 
                'N/A';
            
            return {
                tokens: stats,
                overall: {
                    totalTokens: tokenStats.length,
                    availableTokens: tokenStats.filter(stat => !stat.points || stat.points.totalCredit >= 1).length,
                    totalCalls,
                    totalSuccessCalls,
                    overallSuccessRate
                }
            };
        }

    }

}