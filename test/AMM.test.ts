import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";
import { parseEventLogs } from "viem";

describe("AMM", async () => {
  const FEE_BPS = 30; // 0.30%

  const { viem }: any = await network.connect();

  const publicClient = await viem.getPublicClient();

  let amm: any;
  let tokenA: any;
  let tokenB: any;
  let deployer: any;
  let poolId: `0x${string}`;

  before(async () => {
    [deployer] = await viem.getWalletClients();

    tokenA = await viem.deployContract("MockToken", ["TokenA", "TKA", 18], {
      account: deployer.account,
    });
    tokenB = await viem.deployContract("MockToken", ["TokenB", "TKB", 18], {
      account: deployer.account,
    });

    amm = await viem.deployContract("AMM", [FEE_BPS], { account: deployer.account });
  });

  it("creates a pool and mints initial liquidity", async () => {
    const initialA = 1_000n * 10n ** 18n;
    const initialB = 2_000n * 10n ** 18n;

    // Sanity checks: all contract addresses involved must be distinct
    assert.notEqual(tokenA.address, tokenB.address);
    assert.notEqual(tokenA.address, amm.address);
    assert.notEqual(tokenB.address, amm.address);

    await tokenA.write.approve([amm.address, initialA], { account: deployer.account });
    await tokenB.write.approve([amm.address, initialB], { account: deployer.account });

    const tx = await amm.write.createPool(
      [tokenA.address, tokenB.address, initialA, initialB],
      { account: deployer.account },
    );
    const receipt = await publicClient.getTransactionReceipt({ hash: tx });

    // Parse logs properly using parseEventLogs
    const logs = parseEventLogs({
      abi: amm.abi,
      logs: receipt.logs,
      eventName: "PoolCreated",
    }) as any[];

    assert.equal(logs.length, 1, "Should emit exactly one PoolCreated event");

    poolId = logs[0].args.poolId as `0x${string}`;
    assert.ok(poolId, "Pool ID should be defined");

    const [token0, token1, reserve0, reserve1, feeBps, totalSupply] = await amm.read.getPool([
      poolId,
    ]);

    assert.equal(feeBps, FEE_BPS, "Fee should match");

    const expectedTokens = [tokenA.address.toLowerCase(), tokenB.address.toLowerCase()];
    assert.ok(expectedTokens.includes((token0 as string).toLowerCase()), "Token0 should be either tokenA or tokenB");
    assert.ok(expectedTokens.includes((token1 as string).toLowerCase()), "Token1 should be either tokenA or tokenB");
    assert.notEqual((token0 as string).toLowerCase(), (token1 as string).toLowerCase(), "Token0 and Token1 should be distinct");

    // LP balance should equal totalSupply for deployer
    const lpBalance = await amm.read.getLpBalance([poolId, deployer.account.address]);
    assert.equal(lpBalance, totalSupply, "LP balance should equal total supply");

    // Reserves should match initial deposits (modulo ordering)
    assert.equal(reserve0 + reserve1, initialA + initialB, "Total reserves should match deposits");
  });

  it("allows adding and removing liquidity", async () => {
    const extraA = 500n * 10n ** 18n;
    const extraB = 1_000n * 10n ** 18n;

    // Get poolId from previous test (or re-fetch it)
    if (!poolId) {
      const events = await publicClient.getContractEvents({
        address: amm.address,
        abi: amm.abi,
        eventName: "PoolCreated",
        fromBlock: 0n,
        strict: true,
      });

      assert.ok(events.length > 0, "Should have at least one pool");
      poolId = (events[0] as any).args.poolId as `0x${string}`;
    }

    const [,,, , , totalSupplyBefore] = await amm.read.getPool([poolId]);
    const lpBalanceBefore = await amm.read.getLpBalance([poolId, deployer.account.address]);

    await tokenA.write.approve([amm.address, extraA], { account: deployer.account });
    await tokenB.write.approve([amm.address, extraB], { account: deployer.account });

    const addRes = await amm.write.addLiquidity([poolId, extraA, extraB], {
      account: deployer.account,
    });
    await publicClient.getTransactionReceipt({ hash: addRes });

    const [,,, , , totalSupplyAfter] = await amm.read.getPool([poolId]);
    const lpBalanceAfter = await amm.read.getLpBalance([poolId, deployer.account.address]);

    assert.ok(BigInt(totalSupplyAfter) > BigInt(totalSupplyBefore), "Total supply should increase");
    assert.ok(BigInt(lpBalanceAfter) > BigInt(lpBalanceBefore), "LP balance should increase");

    const liquidityToRemove = (BigInt(lpBalanceAfter) - BigInt(lpBalanceBefore)) / 2n;
    const removeRes = await amm.write.removeLiquidity([poolId, liquidityToRemove], {
      account: deployer.account,
    });
    await publicClient.getTransactionReceipt({ hash: removeRes });

    const lpBalanceFinal = await amm.read.getLpBalance([poolId, deployer.account.address]);
    assert.equal(lpBalanceFinal, lpBalanceAfter - liquidityToRemove, "LP balance should decrease by removed amount");
  });

  it("executes a swap with fee and constant product", async () => {
    // Get poolId from previous test
    if (!poolId) {
      const events = await publicClient.getContractEvents({
        address: amm.address,
        abi: amm.abi,
        eventName: "PoolCreated",
        fromBlock: 0n,
        strict: true,
      });

      assert.ok(events.length > 0, "Should have at least one pool");
      poolId = (events[0] as any).args.poolId as `0x${string}`;
    }

    const [token0, token1, reserve0Before, reserve1Before] = await amm.read.getPool([
      poolId,
    ]);

    const amountIn = 100n * 10n ** 18n;

    // Choose token0 as input token
    const tokenIn = token0;
    const tokenInContract = tokenIn === tokenA.address ? tokenA : tokenB;

    // IMPORTANT: Approve the AMM contract to spend tokens from the deployer
    // Use tokenInContract.write.approve instead of deployer.writeContract
    await tokenInContract.write.approve([amm.address, amountIn], { 
      account: deployer.account 
    });

    // Verify the allowance was set correctly
    const allowance = await tokenInContract.read.allowance([
      deployer.account.address,
      amm.address,
    ]);
    assert.equal(allowance, amountIn, "Allowance should be set correctly");

    const minAmountOut = 1n; // loose slippage for test
    
    // Use amm.write.swap instead of deployer.writeContract for cleaner syntax
    const swapRes = await amm.write.swap(
      [poolId, tokenIn, amountIn, minAmountOut, deployer.account.address],
      { account: deployer.account }
    );
    
    const swapReceipt = await publicClient.getTransactionReceipt({ hash: swapRes });

    // Parse swap logs properly
    const swapLogs = parseEventLogs({
      abi: amm.abi,
      logs: swapReceipt.logs,
      eventName: "Swap",
    }) as any[];

    assert.equal(swapLogs.length, 1, "Should emit exactly one Swap event");

    const amountOut = swapLogs[0].args.amountOut as bigint;
    assert.ok(amountOut > 0n, "Amount out should be positive");

    const [,, reserve0After, reserve1After] = await amm.read.getPool([poolId]);

    const kBefore = BigInt(reserve0Before) * BigInt(reserve1Before);
    const kAfter = BigInt(reserve0After) * BigInt(reserve1After);

    // With fee, kAfter should be >= kBefore
    assert.ok(kAfter >= kBefore, "K should not decrease (constant product with fees)");
  });

  it("calculates correct swap amounts with fee", async () => {
    // Get poolId
    if (!poolId) {
      const events = await publicClient.getContractEvents({
        address: amm.address,
        abi: amm.abi,
        eventName: "PoolCreated",
        fromBlock: 0n,
        strict: true,
      });
      poolId = (events[0] as any).args.poolId as `0x${string}`;
    }

    const [token0, , reserve0Before, reserve1Before, feeBps] = await amm.read.getPool([poolId]);

    const amountIn = 50n * 10n ** 18n;
    const tokenInContract = token0 === tokenA.address ? tokenA : tokenB;

    // Calculate expected output
    const amountInWithFee = (amountIn * (10000n - BigInt(feeBps))) / 10000n;
    const numerator = amountInWithFee * BigInt(reserve1Before);
    const denominator = BigInt(reserve0Before) + amountInWithFee;
    const expectedAmountOut = numerator / denominator;

    // Execute swap
    await tokenInContract.write.approve([amm.address, amountIn], { 
      account: deployer.account 
    });

    const swapRes = await amm.write.swap(
      [poolId, token0, amountIn, 1n, deployer.account.address],
      { account: deployer.account }
    );

    const swapReceipt = await publicClient.getTransactionReceipt({ hash: swapRes });
    const swapLogs = parseEventLogs({
      abi: amm.abi,
      logs: swapReceipt.logs,
      eventName: "Swap",
    }) as any[];

    const actualAmountOut = swapLogs[0].args.amountOut as bigint;

    // Should match expected (or be very close due to rounding)
    assert.ok(
      actualAmountOut === expectedAmountOut || 
      actualAmountOut === expectedAmountOut + 1n ||
      actualAmountOut === expectedAmountOut - 1n,
      "Actual amount out should match expected calculation"
    );
  });

  it("prevents double pool creation", async () => {
    const amount = 100n * 10n ** 18n;

    await tokenA.write.approve([amm.address, amount], { account: deployer.account });
    await tokenB.write.approve([amm.address, amount], { account: deployer.account });

    // Try to create the same pool again
    await assert.rejects(
      async () => {
        await amm.write.createPool(
          [tokenA.address, tokenB.address, amount, amount],
          { account: deployer.account }
        );
      },
      /pool exists/,
      "Should revert with 'pool exists'"
    );
  });

  it("enforces minimum liquidity requirements", async () => {
    // Try to add zero liquidity
    if (!poolId) {
      const events = await publicClient.getContractEvents({
        address: amm.address,
        abi: amm.abi,
        eventName: "PoolCreated",
        fromBlock: 0n,
        strict: true,
      });
      poolId = (events[0] as any).args.poolId as `0x${string}`;
    }

    await assert.rejects(
      async () => {
        await amm.write.addLiquidity([poolId, 0n, 100n * 10n ** 18n], {
          account: deployer.account
        });
      },
      /insufficient amounts/,
      "Should revert with 'insufficient amounts'"
    );
  });

  it("enforces slippage protection on swaps", async () => {
    if (!poolId) {
      const events = await publicClient.getContractEvents({
        address: amm.address,
        abi: amm.abi,
        eventName: "PoolCreated",
        fromBlock: 0n,
        strict: true,
      });
      poolId = (events[0] as any).args.poolId as `0x${string}`;
    }

    const [token0] = await amm.read.getPool([poolId]);
    const tokenInContract = token0 === tokenA.address ? tokenA : tokenB;
    const amountIn = 10n * 10n ** 18n;

    await tokenInContract.write.approve([amm.address, amountIn], { 
      account: deployer.account 
    });

    // Set unrealistic minAmountOut (higher than possible)
    const unrealisticMin = 1000n * 10n ** 18n;

    await assert.rejects(
      async () => {
        await amm.write.swap(
          [poolId, token0, amountIn, unrealisticMin, deployer.account.address],
          { account: deployer.account }
        );
      },
      /slippage/,
      "Should revert with 'slippage'"
    );
  });
});