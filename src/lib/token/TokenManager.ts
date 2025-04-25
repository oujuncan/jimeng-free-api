import _ from 'lodash';
import logger from '@/lib/logger.ts';
import { getCredit } from '@/api/controllers/core.ts';

interface TokenStats {
  token: string;
  totalCalls: number;
  successCalls: number;
  lastUsed: number;
  points?: {
    giftCredit: number;
    purchaseCredit: number;
    vipCredit: number;
    totalCredit: number;
  };
}

/**
 * 令牌管理器
 * 负责管理令牌的加权轮询负载均衡策略
 */
class TokenManager {
  private static instance: TokenManager;
  private tokenStats: Map<string, TokenStats> = new Map();
  private lastRefreshed: number = 0;
  // 刷新积分间隔（毫秒）
  private readonly REFRESH_INTERVAL = 5 * 60 * 1000; // 5分钟
  // 权重计算参数
  private readonly POINTS_WEIGHT = 0.7; // 积分权重
  private readonly SUCCESS_RATE_WEIGHT = 0.3; // 成功率权重
  // 最小调用次数
  private readonly MIN_CALLS = 5;

  private constructor() {}

  /**
   * 获取单例实例
   */
  public static getInstance(): TokenManager {
    if (!TokenManager.instance) {
      TokenManager.instance = new TokenManager();
    }
    return TokenManager.instance;
  }

  /**
   * 初始化令牌统计
   * @param tokens 令牌列表
   */
  public async initializeTokens(tokens: string[]): Promise<void> {
    const currentTime = Date.now();
    
    // 只保留传入的token
    const currentTokens = Array.from(this.tokenStats.keys());
    for (const token of currentTokens) {
      if (!tokens.includes(token)) {
        this.tokenStats.delete(token);
      }
    }

    // 添加新的token
    for (const token of tokens) {
      if (!this.tokenStats.has(token)) {
        this.tokenStats.set(token, {
          token,
          totalCalls: 0,
          successCalls: 0,
          lastUsed: 0
        });
      }
    }

    // 如果距离上次刷新时间超过了刷新间隔，则刷新积分
    // if (currentTime - this.lastRefreshed > this.REFRESH_INTERVAL) {
      await this.refreshTokenPoints();
    // }
  }

  /**
   * 刷新所有令牌的积分信息
   */
  private async refreshTokenPoints(): Promise<void> {
    logger.info('刷新令牌积分信息中...');
    const tokens = Array.from(this.tokenStats.keys());
    
    try {
      for (const token of tokens) {
        try {
          const points = await getCredit(token);
          const stats = this.tokenStats.get(token);
          if (stats) {
            this.tokenStats.set(token, {
              ...stats,
              points
            });
          }
        } catch (error) {
          logger.error(`获取令牌 ${token.substring(0, 8)}... 积分失败: ${error.message}`);
        }
      }
      this.lastRefreshed = Date.now();
      logger.info('令牌积分信息刷新完成');
    } catch (error) {
      logger.error(`刷新令牌积分信息失败: ${error.message}`);
    }
  }

  /**
   * 根据加权轮询策略选择令牌
   * @returns 选择的令牌
   */
  public selectToken(): string | null {
    const availableTokens = Array.from(this.tokenStats.values())
      .filter(stats => {
        // 过滤掉积分小于1的令牌
        return !stats.points || stats.points.totalCredit >= 1;
      });

    if (availableTokens.length === 0) {
      logger.warn('没有可用的令牌');
      return null;
    }

    // 如果只有一个可用令牌，直接返回
    if (availableTokens.length === 1) {
      const token = availableTokens[0].token;
      this.updateLastUsed(token);
      return token;
    }

    // 计算所有令牌的权重
    const tokenWeights = availableTokens.map(stats => {
      const successRate = stats.totalCalls > 0 
        ? stats.successCalls / stats.totalCalls 
        : 0.5; // 如果没有调用记录，默认成功率为0.5
      
      // 积分权重，如果没有积分信息，默认为1
      const pointsWeight = stats.points 
        ? Math.min(stats.points.totalCredit / 100, 10) // 限制积分权重最大为10
        : 1;
      
      // 成功率权重
      // 如果调用次数小于最小调用次数，则使用默认成功率
      const successRateWeight = stats.totalCalls >= this.MIN_CALLS
        ? successRate
        : 0.5;
      
      // 总权重 = 积分权重 * 积分比例 + 成功率 * 成功率比例
      const weight = (pointsWeight * this.POINTS_WEIGHT) + 
                     (successRateWeight * this.SUCCESS_RATE_WEIGHT);
      
      return {
        token: stats.token,
        weight: Math.max(weight, 0.01) // 确保权重至少为0.01
      };
    });

    // 根据权重进行加权随机选择
    const totalWeight = tokenWeights.reduce((sum, item) => sum + item.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const tokenWeight of tokenWeights) {
      random -= tokenWeight.weight;
      if (random <= 0) {
        this.updateLastUsed(tokenWeight.token);
        return tokenWeight.token;
      }
    }

    // 如果出现浮点数精度问题导致没有选中，则返回最后一个令牌
    const lastToken = tokenWeights[tokenWeights.length - 1].token;
    this.updateLastUsed(lastToken);
    return lastToken;
  }

  /**
   * 更新令牌最后使用时间
   * @param token 令牌
   */
  private updateLastUsed(token: string): void {
    const stats = this.tokenStats.get(token);
    if (stats) {
      stats.lastUsed = Date.now();
      this.tokenStats.set(token, stats);
    }
  }

  /**
   * 记录令牌调用成功
   * @param token 令牌
   */
  public recordSuccess(token: string): void {
    const stats = this.tokenStats.get(token);
    if (stats) {
      stats.totalCalls += 1;
      stats.successCalls += 1;
      this.tokenStats.set(token, stats);
    }
  }

  /**
   * 记录令牌调用失败
   * @param token 令牌
   */
  public recordFailure(token: string): void {
    const stats = this.tokenStats.get(token);
    if (stats) {
      stats.totalCalls += 1;
      this.tokenStats.set(token, stats);
    }
  }

  /**
   * 获取所有令牌统计信息
   */
  public getTokenStats(): TokenStats[] {
    return Array.from(this.tokenStats.values());
  }
}

export default TokenManager; 