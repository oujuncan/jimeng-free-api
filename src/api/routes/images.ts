import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import { generateImages } from "@/api/controllers/images.ts";
import { tokenSplit } from "@/api/controllers/core.ts";
import util from "@/lib/util.ts";
import TokenManager from '@/lib/token/TokenManager.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import EX from '@/api/consts/exceptions.ts';
import logger from '@/lib/logger.ts';

export default {
  prefix: "/v1/images",

  post: {
    "/generations": async (request: Request) => {
      request
        .validate("body.model", v => _.isUndefined(v) || _.isString(v))
        .validate("body.prompt", _.isString)
        .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
        .validate("body.size", v => _.isUndefined(v) || _.isString(v))
        .validate("body.width", v => _.isUndefined(v) || _.isFinite(v))
        .validate("body.height", v => _.isUndefined(v) || _.isFinite(v))
        .validate("body.sample_strength", v => _.isUndefined(v) || _.isFinite(v))
        .validate("body.response_format", v => _.isUndefined(v) || _.isString(v))
        .validate("headers.authorization", _.isString);
      
      // 打印完整请求体以便调试
      logger.info(`[图像生成请求] 请求体: ${JSON.stringify(request.body)}`);
      
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
        
        const {
          model,
          prompt,
          negative_prompt: negativePrompt,
          size,
          width: explicitWidth,
          height: explicitHeight,
          sample_strength: sampleStrength,
          response_format,
        } = request.body;
        
        // 解析size参数（如果提供）
        let parsedWidth, parsedHeight;
        if (size && _.isString(size)) {
          const sizeMatch = size.match(/^(\d+)x(\d+)$/);
          if (sizeMatch) {
            parsedWidth = parseInt(sizeMatch[1], 10);
            parsedHeight = parseInt(sizeMatch[2], 10);
          } else {
            logger.warn(`[图像生成请求] size参数格式不正确: ${size}，应为 "宽度x高度" 格式`);
          }
        }
        
        // 优先使用显式提供的width和height，如果没有则使用从size解析的值
        const width = explicitWidth !== undefined ? explicitWidth : parsedWidth;
        const height = explicitHeight !== undefined ? explicitHeight : parsedHeight;
        
        try {
          const responseFormat = _.defaultTo(response_format, "url");
          const imageUrls = await generateImages(model, prompt, {
            width,
            height,
            sampleStrength,
            negativePrompt,
          }, token);
          
          // 记录成功
          tokenManager.recordSuccess(token);
          
          let data = [];
          if (responseFormat == "b64_json") {
            data = (
              await Promise.all(imageUrls.map((url) => util.fetchFileBASE64(url)))
            ).map((b64) => ({ b64_json: b64 }));
          } else {
            data = imageUrls.map((url) => ({
              url,
            }));
          }
          
          return {
            created: util.unixTimestamp(),
            data,
          };
        } catch (error) {
          // 记录失败
          tokenManager.recordFailure(token);
          logger.error(`令牌 ${token.substring(0, 8)}... 图像生成请求失败: ${error.message}`);
          throw error;
        }
      } catch (error) {
        if (error instanceof APIException) throw error;
        throw new APIException(EX.API_REQUEST_FAILED, `请求失败: ${error.message}`);
      }
    },
  },
};
