const { getNamedAccounts, deployments, ethers, network } = require("hardhat");
const {
  developmentChains,
  networkConfig,
} = require("../../helper-hardhat-config");
const { assert, expect } = require("chai");

describe("Lottery", function () {
  if (!developmentChains.includes(network.name)) {
    describe.skip("Skipping Lottery tests on non-development chain", function () {
      // No tests are included here because the entire suite is skipped
    });
    return;
  }

  let lottery, vrfCoordinatorV2Mock, lotteryEntranceFee, deployer, interval;
  const chainId = network.config.chainId;

  beforeEach(async function () {
    deployer = (await getNamedAccounts()).deployer;
    await deployments.fixture(["all"]);
    lottery = await ethers.getContract("Lottery", deployer);
    vrfCoordinatorV2Mock = await ethers.getContract(
      "VRFCoordinatorV2Mock",
      deployer
    );
    lotteryEntranceFee = await lottery.getEntryFee();
    interval = await lottery.getInterval();
  });

  describe("constructor", function () {
    it("Initializes the Lottery correctly", async function () {
      const lotteryState = await lottery.getLotteryState();

      assert.equal(lotteryState.toString(), "0");
      assert.equal(interval.toString(), networkConfig[chainId]["interval"]);
    });
  });

  describe("enterLottery", function () {
    it("Revert when you dont pay enough", async function () {
      await expect(lottery.enterLottery()).to.be.revertedWith(
        "Lottery__NotEnoughETHEntered"
      );
    });
    it("records players when they enter", async function () {
      await lottery.enterLottery({ value: lotteryEntranceFee });
      const playerFromContract = await lottery.getPlayers(0);
      assert.equal(playerFromContract, deployer);
    });
    it("emits event on enter", async function () {
      await expect(lottery.enterLottery({ value: lotteryEntranceFee })).to.emit(
        // emits lotteryEnter event if entered to index player(s) address
        lottery,
        "lotteryEnter"
      );
    });
    it("doesn't allow entrance when lottery is calculating", async () => {
      await lottery.enterLottery({ value: lotteryEntranceFee });
      // for a documentation of the methods below, go here: https://hardhat.org/hardhat-network/reference
      await network.provider.send("evm_increaseTime", [
        interval.toNumber() + 1,
      ]);
      await network.provider.request({ method: "evm_mine", params: [] });
      // we pretend to be a keeper for a second
      await lottery.performUpkeep([]); // changes the state to calculating for our comparison below
      await expect(
        lottery.enterLottery({ value: lotteryEntranceFee })
      ).to.be.revertedWith(
        // is reverted as lottery is calculating
        "Lottery__NotOpen"
      );
    });
  });
  describe("checkupKeep", function () {
    it("returns false if pepople havent send any ETH", async function () {
      await network.provider.send("evm_increaseTime", [
        interval.toNumber() + 1,
      ]);
      await network.provider.request({ method: "evm_mine", params: [] });
      const { upKeepNeeded } = await lottery.callStatic.checkUpkeep("0x");
      assert(!upKeepNeeded);
    });
    it("return false if lottery is not open", async function () {
      await lottery.enterLottery({ value: lotteryEntranceFee });
      await network.provider.send("evm_increaseTime", [
        interval.toNumber() + 1,
      ]);
      await network.provider.request({ method: "evm_mine", params: [] });
      await lottery.performUpkeep("0x");
      const lotteryState = await lottery.getLotteryState();
      const { upKeepNeeded } = await lottery.callStatic.checkUpkeep("0x");
      assert.equal(lotteryState.toString(), "1");
      assert.equal(upKeepNeeded, false);
    });
    it("returns false if enough time hasnt passed", async function () {
      await lottery.enterLottery({ value: lotteryEntranceFee });
      await network.provider.send("evm_increaseTime", [
        interval.toNumber() - 1,
      ]);
      const { upKeepNeeded } = await lottery.callStatic.checkUpkeep("0x");
      assert(!upKeepNeeded);
    });
    it("return true if enough time has passed, has players, eth, and is open", async function () {
      await lottery.enterLottery({ value: lotteryEntranceFee });
      await network.provider.send("evm_increaseTime", [
        interval.toNumber() + 1,
      ]);
      await network.provider.request({ method: "evm_mine", pragma: [] });
      const { upKeepNeeded } = await lottery.callStatic.checkUpkeep("0x");
      assert(upKeepNeeded);
    });
  });
  describe("performUpKeep", function () {
    it("it can only run if checkUpKeep is true", async function () {
      await lottery.enterLottery({ value: lotteryEntranceFee });
      await network.provider.send("evm_increaseTime", [
        interval.toNumber() + 1,
      ]);
      await network.provider.send("evm_mine", []);
      const tx = await lottery.performUpkeep([]);
      assert(tx);
    });
    it("reverts when checkUpkeep is false", async function () {
      await expect(lottery.performUpkeep([])).to.be.revertedWith(
        "Lottery__UpKeepNotNeeded"
      );
    });
    it("update the raffle state, emits and event, and calls the vrfCoordinator", async function () {
      await lottery.enterLottery({ value: lotteryEntranceFee });
      await network.provider.send("evm_increaseTime", [
        interval.toNumber() + 1,
      ]);
      await network.provider.send("evm_mine", []);
      const txResponse = await lottery.performUpkeep([]);
      const txReceipt = await txResponse.wait(1);
      const requestId = txReceipt.events[1].args.requestId;
      const lotteryState = await lottery.getLotteryState();
      assert(requestId.toNumber() > 0);
      assert(lotteryState.toString() == "1");
    });
  });
  describe("fullfillRandomWords", function () {
    beforeEach(async function () {
      await lottery.enterLottery({ value: lotteryEntranceFee });
      await network.provider.send("evm_increaseTime", [
        interval.toNumber() + 1,
      ]);
      await network.provider.send("evm_mine", []);
    });
    it("can only be called after performUpKeep", async function () {
      await expect(
        vrfCoordinatorV2Mock.fulfillRandomWords(0, lottery.address)
      ).to.be.revertedWith("nonexistent request");
      await expect(
        vrfCoordinatorV2Mock.fulfillRandomWords(1, lottery.address)
      ).to.be.revertedWith("nonexistent request");
    });
    it("picks a winner, resets the lottery, and send money", async function () {
      const additionalEntrants = 3;
      const startingAccountIndex = 1; //deployer = 0
      const accounts = await ethers.getSigners();
      for (
        let i = startingAccountIndex;
        i < startingAccountIndex + additionalEntrants;
        i++
      ) {
        const accountConnectedLottery = lottery.connect(accounts[i]);
        await accountConnectedLottery.enterLottery({
          value: lotteryEntranceFee,
        });
      }
      const startingTimeStamp = await lottery.getLastTimeStamp();

      // performUpKeep (mock being chainLink keeper)
      // fulfullRandomWords (mock being the chainLink VRF)
      // we will have to wait for the fulfillRandomWords to be called
      await new Promise(async (resolve, reject) => {
        lottery.once("WinnerPicked", async () => {
          console.log("Found the event");
          try {
            const recentWinner = await lottery.getRecentWinner();
            const lotteryState = await lottery.getLotteryState();
            const endingTimeStamp = await lottery.getLastTimeStamp();
            const numPlayers = await lottery.getNumberOfPlayers();
            const winnerEndingBalance = await accounts[1].getBalance();
            assert.equal(numPlayers.toString(), "0");
            assert.equal(lotteryState.toString(), "0");
            assert(endingTimeStamp > startingTimeStamp);

            assert.equal(
              winnerEndingBalance.toString(),
              winnerStartingBalance.add(
                lotteryEntranceFee
                  .mul(additionalEntrants)
                  .add(lotteryEntranceFee)
                  .toString()
              )
            );
          } catch (e) {
            reject(e);
          }
          resolve();
        });
        const tx = await lottery.performUpkeep([]);
        const txReceipt = await tx.wait(1);
        const winnerStartingBalance = await accounts[1].getBalance();
        await vrfCoordinatorV2Mock.fulfillRandomWords(
          txReceipt.events[1].args.requestId,
          lottery.address
        );
      });
    });
  });
});
