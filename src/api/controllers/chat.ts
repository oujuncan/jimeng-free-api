import _ from "lodash";
import { PassThrough } from "stream";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import { generateImages, DEFAULT_MODEL } from "./images.ts";

// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;

/**
 * 解析模型
 *
 * @param model 模型名称
 * @returns 模型信息
 */
function parseModel(model: string) {
  // 在日志中记录原始模型值
  logger.info(`[解析模型] 原始模型值: "${model}" (${typeof model})`);
  
  if (!model || typeof model !== 'string') {
    logger.warn(`[解析模型] 模型参数无效，使用默认值 - model: ${DEFAULT_MODEL}, width: 1024, height: 1024`);
    return {
      model: DEFAULT_MODEL,
      width: 1024,
      height: 1024
    };
  }
  
  const [_model, size] = model.split(":");
  logger.info(`[解析模型] 分割结果 - model: "${_model}", size: "${size}"`);
  
  if (!size) {
    logger.info(`[解析模型] 无尺寸信息，使用默认尺寸 - model: ${_model}, width: 1024, height: 1024`);
    return {
      model: _model,
      width: 1024,
      height: 1024,
    };
  }
  
  // 改进尺寸解析，支持更多格式，如 1024x1024、1024*1024、1024-1024
  const sizeMatch = size.match(/(\d+)[\W\w](\d+)/);
  logger.info(`[解析模型] 尺寸匹配结果: ${JSON.stringify(sizeMatch)}`);
  
  if (!sizeMatch) {
    logger.warn(`[解析模型] 尺寸格式无法解析，使用默认尺寸 - model: ${_model}, size: ${size}, width: 1024, height: 1024`);
    return {
      model: _model,
      width: 1024,
      height: 1024,
    };
  }
  
  const [_, widthStr, heightStr] = sizeMatch;
  const width = parseInt(widthStr);
  const height = parseInt(heightStr);
  
  // 确保宽高是有效的数字并且是偶数
  const finalWidth = isNaN(width) ? 1024 : Math.ceil(width / 2) * 2;
  const finalHeight = isNaN(height) ? 1024 : Math.ceil(height / 2) * 2;
  
  logger.info(`[解析模型] 解析完成 - model: ${_model}, width: ${finalWidth}, height: ${finalHeight}`);
  
  return {
    model: _model,
    width: finalWidth,
    height: finalHeight,
  };
}

/**
 * 同步对话补全
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param assistantId 智能体ID，默认使用jimeng原版
 * @param retryCount 重试次数
 */
export async function createCompletion(
  messages: any[],
  refreshToken: string,
  _model = DEFAULT_MODEL,
  retryCount = 0
) {
  return (async () => {
    if (messages.length === 0)
      throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "消息不能为空");

    const { model, width, height } = parseModel(_model);
    logger.info(messages);

    const imageUrls = await generateImages(
      model,
      messages[messages.length - 1].content,
      {
        width,
        height,
      },
      refreshToken
    );

    return {
      id: util.uuid(),
      model: _model || model,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: imageUrls.reduce(
              (acc, url, i) => acc + `![image_${i}](${url})\n`,
              ""
            ),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
    };
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(messages, refreshToken, _model, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 流式对话补全
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param assistantId 智能体ID，默认使用jimeng原版
 * @param retryCount 重试次数
 */
export async function createCompletionStream(
  messages: any[],
  refreshToken: string,
  _model = DEFAULT_MODEL,
  retryCount = 0
) {
  return (async () => {
    const { model, width, height } = parseModel(_model);
    logger.info(messages);

    const stream = new PassThrough();

    if (messages.length === 0) {
      logger.warn("消息为空，返回空流");
      stream.end("data: [DONE]\n\n");
      return stream;
    }

    stream.write(
      "data: " +
        JSON.stringify({
          id: util.uuid(),
          model: _model || model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "🎨 图像生成中，请稍候..." },
              finish_reason: null,
            },
          ],
        }) +
        "\n\n"
    );

    generateImages(
      model,
      messages[messages.length - 1].content,
      { width, height },
      refreshToken
    )
      .then((imageUrls) => {
        for (let i = 0; i < imageUrls.length; i++) {
          const url = imageUrls[i];
          stream.write(
            "data: " +
              JSON.stringify({
                id: util.uuid(),
                model: _model || model,
                object: "chat.completion.chunk",
                choices: [
                  {
                    index: i + 1,
                    delta: {
                      role: "assistant",
                      content: `![image_${i}](${url})\n`,
                    },
                    finish_reason: i < imageUrls.length - 1 ? null : "stop",
                  },
                ],
              }) +
              "\n\n"
          );
        }
        stream.write(
          "data: " +
            JSON.stringify({
              id: util.uuid(),
              model: _model || model,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: imageUrls.length + 1,
                  delta: {
                    role: "assistant",
                    content: "图像生成完成！",
                  },
                  finish_reason: "stop",
                },
              ],
            }) +
            "\n\n"
        );
        stream.end("data: [DONE]\n\n");
      })
      .catch((err) => {
        stream.write(
          "data: " +
            JSON.stringify({
              id: util.uuid(),
              model: _model || model,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 1,
                  delta: {
                    role: "assistant",
                    content: `生成图片失败: ${err.message}`,
                  },
                  finish_reason: "stop",
                },
              ],
            }) +
            "\n\n"
        );
        stream.end("data: [DONE]\n\n");
      });
    return stream;
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Response error: ${err.stack}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(
          messages,
          refreshToken,
          _model,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}
