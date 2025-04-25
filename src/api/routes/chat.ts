import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { tokenSplit } from '@/api/controllers/core.ts';
import { createCompletion, createCompletionStream } from '@/api/controllers/chat.ts';
import TokenManager from '@/lib/token/TokenManager.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import EX from '@/api/consts/exceptions.ts';
import logger from '@/lib/logger.ts';

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.messages', _.isArray)
                .validate('headers.authorization', _.isString)
            
            // 打印请求体以便调试
            logger.info(`[聊天补全请求] 请求体: ${JSON.stringify({
                model: request.body.model,
                stream: request.body.stream,
                messagesCount: request.body.messages?.length || 0
            })}`);
            
            try {
                // refresh_token切分
                const tokens = tokenSplit(request.headers.authorization);
                
                // 初始化令牌管理器
                const tokenManager = TokenManager.getInstance();
                await tokenManager.initializeTokens(tokens);
                
                // 根据加权轮询策略选择令牌
                const token = tokenManager.selectToken();
                
                if (!token) {
                    throw new APIException(EX.API_INVALID_REFRESH_TOKEN, '所有令牌均无效或积分不足');
                }
                
                const { model, messages, stream } = request.body;
                
                // 详细记录提取的参数
                logger.info(`[聊天补全请求] 提取参数 - model: ${model} (${typeof model}), stream: ${stream}, messagesCount: ${messages?.length || 0}`);
                
                try {
                    if (stream) {
                        const stream = await createCompletionStream(messages, token, model);
                        // 记录成功
                        tokenManager.recordSuccess(token);
                        return new Response(stream, {
                            type: "text/event-stream"
                        });
                    } else {
                        const result = await createCompletion(messages, token, model);
                        // 记录成功
                        tokenManager.recordSuccess(token);
                        return result;
                    }
                } catch (error) {
                    // 记录失败
                    tokenManager.recordFailure(token);
                    logger.error(`令牌 ${token.substring(0, 8)}... 请求失败: ${error.message}`);
                    throw error;
                }
            } catch (error) {
                if (error instanceof APIException) throw error;
                throw new APIException(EX.API_REQUEST_FAILED, `请求失败: ${error.message}`);
            }
        }

    }

}