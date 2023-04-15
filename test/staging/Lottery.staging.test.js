const { getNamedAccounts, deployments, ethers, network } = require("hardhat");
const {
  developmentChains,
  networkConfig,
} = require("../../helper-hardhat-config");
const { assert, expect } = require("chai");

describe("Lottery", function () {
  if (developmentChains.includes(network.name)) {
    describe.skip("Skipping Lottery tests on development chain", function () {
      // No tests are included here because the entire suite is skipped
    });
    return;
  }

  let lottery, vrfCoordinatorV2Mock, lotteryEntranceFee, deployer, interval;

  beforeEach(async function () {
    deployer = (await getNamedAccounts()).deployer;
    lottery = await ethers.getContract("Lottery", deployer);
    lotteryEntranceFee = await lottery.getEntryFee();
  });

  describe("fulfillRandomWords", async function () {
    it("works with live Chainlink keepres and Chainlink VRF, we get a random winnner", async function () {
      const startingTimeStamp = await lottery.getLastTimeStamp();
      const accounts = await ethers.getSigners();
      await new Promise(async (resolve, reject) => {
        lottery.once("WinnerPicked", async () => {
          console.log("winnerPicked Event fired!");
          resolve();
          try {
            const recentWinner = await lottery.getRecentWinner();
            const lotteryState = await lottery.getLotteryState();
            const winnerEndingBalance = await accounts[0].getBalance();
            const endingTimeStamp = await lottery.getLastTimeStamp();

            await expect(lottery.getPlayer(0)).to.be.reverted;
            assert.equal(recentWinner.toString(), accounts[0].address);
            assert.equal(lotteryState.toString(), "0");
            assert.equal(
              winnerEndingBalance.toString(),
              winnerStartingBalance.add(lotteryEntranceFee).toString()
            );
            assert(endingTimeStamp > startingTimeStamp);
            resolve();
          } catch (error) {
            console.log(error);
            reject(error);
          }
        });
        await lottery.enterLottery({ value: lotteryEntranceFee });
        const winnerStartingBalance = await accounts[0].getBalance();
      });
    });
  });
});
