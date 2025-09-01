import { ApiPromise, WsProvider } from "@polkadot/api";
import avnTypes from "avn-types";
import BN from "bn.js";
import {
  NODE_URL,
  REWARD_PERIOD_INDEX,
  GROUP_NAMESPACE,
  ADDRESS,
  SPECIFIC_BLOCK_HASH,
} from "./constants.js";

/// Validation
async function validateInput(api) {
  console.log("🔍 Validating input parameters...");

  // Check for undefined or invalid required parameters
  if (
    REWARD_PERIOD_INDEX === undefined ||
    REWARD_PERIOD_INDEX === null ||
    isNaN(REWARD_PERIOD_INDEX) ||
    REWARD_PERIOD_INDEX <= 0
  ) {
    throw new Error(
      "REWARD_PERIOD_INDEX is required and must be a positive number, but got: " +
        REWARD_PERIOD_INDEX
    );
  }

  if (
    !GROUP_NAMESPACE ||
    typeof GROUP_NAMESPACE !== "string" ||
    GROUP_NAMESPACE.trim() === ""
  ) {
    throw new Error(
      "GROUP_NAMESPACE is required and must be a non-empty string, but got: " +
        GROUP_NAMESPACE
    );
  }

  if (!ADDRESS || typeof ADDRESS !== "string" || ADDRESS.trim() === "") {
    throw new Error(
      "ADDRESS is required and must be a non-empty string, but got: " + ADDRESS
    );
  }

  console.log("✅ All required parameters are defined");
  console.log(`   REWARD_PERIOD_INDEX: ${REWARD_PERIOD_INDEX}`);
  console.log(`   GROUP_NAMESPACE: ${GROUP_NAMESPACE}`);
  console.log(`   ADDRESS: ${ADDRESS}`);

  // Check if ADDRESS was subscribed for REWARD_PERIOD_INDEX to GROUP_NAMESPACE
  console.log("🔍 Checking subscription status...");

  try {
    // Get the current active reward period info to determine the block for the requested period
    const activeRewardPeriodInfo =
      await api.query.workerNodePallet.activeRewardPeriodInfo();
    const currentPeriod = activeRewardPeriodInfo.toJSON();

    // Calculate the block number for the requested period
    const periodsBack = currentPeriod.index - REWARD_PERIOD_INDEX;
    const periodStartBlock =
      currentPeriod.firstBlock - periodsBack * currentPeriod.length;

    // Get the block hash for the start of the requested period
    const periodBlockHash = await api.rpc.chain.getBlockHash(periodStartBlock);

    console.log(
      `   Querying stake record at block ${periodStartBlock} (${periodBlockHash})`
    );

    // Query the SolutionGroupStakeRecords storage item
    // StorageDoubleMap: (SolutionGroupNamespace, AccountId) -> StakeRecord
    const stakeRecord =
      await api.query.workerNodePallet.solutionGroupStakeRecords.at(
        periodBlockHash,
        GROUP_NAMESPACE,
        ADDRESS
      );

    if (stakeRecord.isNone) {
      throw new Error(
        `Address ${ADDRESS} was not subscribed to group ${GROUP_NAMESPACE} in period ${REWARD_PERIOD_INDEX}`
      );
    }

    // Decode the stake record to check the stake for the specific period
    const stakeRecordData = stakeRecord.unwrap();

    // The StakeRecord is a BoundedBTreeMap<RewardPeriodIndex, Stake>
    // The key represents the LAST UPDATE period, and the value is the current stake amount
    // This stake amount applies to all periods from the last update onwards
    let hasValidStake = false;
    let stakeValue = new BN(0);
    let lastUpdatePeriod = 0;

    try {
      // Parse the human-readable format of the stake record
      const stakeRecordHuman = stakeRecordData.toHuman();

      if (stakeRecordHuman && typeof stakeRecordHuman === "object") {
        // Find the highest period (most recent update) in the stake record
        for (const [period, stake] of Object.entries(stakeRecordHuman)) {
          const periodNum = parseInt(period);
          if (periodNum > lastUpdatePeriod) {
            lastUpdatePeriod = periodNum;

            // Parse the stake value using BN for large numbers
            if (typeof stake === "string" && stake.startsWith("0x")) {
              stakeValue = new BN(stake, 16);
            } else {
              stakeValue = new BN(stake.toString().replace(/,/g, "")); // Remove commas and parse
            }
          }
        }

        // Check if the requested period is >= the last update period
        // and if the stake amount is > 0
        if (
          REWARD_PERIOD_INDEX >= lastUpdatePeriod &&
          stakeValue.gt(new BN(0))
        ) {
          hasValidStake = true;
          console.log(
            `   Last stake update was in period ${lastUpdatePeriod}, current stake: ${stakeValue.toString()}`
          );
          console.log(
            `   Requested period ${REWARD_PERIOD_INDEX} is >= last update period, subscription is valid`
          );
        } else {
          console.log(
            `   Last stake update was in period ${lastUpdatePeriod}, current stake: ${stakeValue.toString()}`
          );
          console.log(
            `   Requested period ${REWARD_PERIOD_INDEX} is < last update period or stake is 0, subscription is invalid`
          );
        }
      }
    } catch (parseError) {
      console.log(`   Error parsing stake record: ${parseError.message}`);
      // If we can't parse it, assume no valid stake
      hasValidStake = false;
    }

    if (!hasValidStake) {
      throw new Error(
        `Address ${ADDRESS} was not subscribed to group ${GROUP_NAMESPACE} in period ${REWARD_PERIOD_INDEX} ` +
          `(stake: ${stakeValue.toString()})`
      );
    }

    console.log(
      `   ✅ Address was subscribed with stake: ${stakeValue.toString()}`
    );
  } catch (error) {
    if (error.message.includes("was not subscribed")) {
      throw error; // Re-throw subscription validation errors
    }
    throw new Error(`Failed to validate subscription: ${error.message}`);
  }

  console.log("✅ Input validation completed");
}

/// Helper to find the required blocks for a period
async function findBlockForPeriod(api, periodIndex) {
  // Step 1: Get the current active reward period info
  const activeRewardPeriodInfo =
    await api.query.workerNodePallet.activeRewardPeriodInfo();
  const currentPeriod = activeRewardPeriodInfo.toJSON();

  console.debug(`Current active reward period:`, currentPeriod);
  console.debug(`Requested period: ${periodIndex}`);
  console.debug(`Periods difference: ${currentPeriod.index - periodIndex}`);

  if (periodIndex > currentPeriod.index) {
    throw new Error(
      `Requested period ${periodIndex} is in the future. Current period is ${currentPeriod.index}`
    );
  }

  // Step 2: find the block in the *next* period when RewardsCalculatedForPeriod(periodIndex) was emitted
  // We need to scan forward from the period after the requested one
  const nextPeriodIndex = periodIndex + 1;

  if (nextPeriodIndex > currentPeriod.index) {
    throw new Error(
      `Period ${periodIndex} is the current period (${currentPeriod.index}) or in the future. ` +
        `RewardsCalculatedForPeriod event has not been emitted yet.`
    );
  }

  // Calculate the block range for the next period
  // First, calculate the start block of the requested period
  const requestedPeriodStartBlock =
    currentPeriod.firstBlock -
    (currentPeriod.index - periodIndex) * currentPeriod.length;

  // Then, the next period starts right after the requested period ends
  const nextPeriodStartBlock = requestedPeriodStartBlock + currentPeriod.length;
  const nextPeriodEndBlock = nextPeriodStartBlock + currentPeriod.length - 1;

  console.debug(
    `Requested period ${periodIndex} starts at block ${requestedPeriodStartBlock}`
  );
  console.debug(
    `Next period ${nextPeriodIndex} starts at block ${nextPeriodStartBlock}`
  );

  // Count SystemVotingRounds in the previous period to determine minimum processing time
  const previousPeriodIndex = periodIndex - 1;
  let startBlock = nextPeriodStartBlock;

  if (previousPeriodIndex >= 0) {
    try {
      console.debug(
        `\n🔍 Counting SystemVotingRounds in previous period ${previousPeriodIndex}...`
      );

      // Get the last block of the previous period
      const previousPeriodStartBlock =
        requestedPeriodStartBlock - currentPeriod.length;
      const previousPeriodEndBlock = requestedPeriodStartBlock - 1;

      console.debug(
        `Previous period ${previousPeriodIndex} blocks: ${previousPeriodStartBlock} to ${previousPeriodEndBlock}`
      );

      // Query at the end of the previous period to get the total count
      const previousPeriodEndHash = await api.rpc.chain.getBlockHash(
        previousPeriodEndBlock
      );

      // Count all SystemVotingRound entries for the previous period
      const previousPeriodSystemVotingRounds =
        await api.query.workerNodePallet.systemVotingRound.entriesAt(
          previousPeriodEndHash,
          previousPeriodIndex
        );

      const totalSystemVotingRounds = previousPeriodSystemVotingRounds.length;
      console.debug(
        `Found ${totalSystemVotingRounds} SystemVotingRounds in previous period ${previousPeriodIndex}`
      );

      // Calculate start block: start of next period + minimum processing time
      // The system needs at least this many blocks to process all voting rounds
      startBlock = nextPeriodStartBlock + totalSystemVotingRounds;

      console.debug(
        `Search start: block ${startBlock} (${nextPeriodStartBlock} + ${totalSystemVotingRounds} SystemVotingRounds)`
      );
      console.debug(
        `This reduces search range from ${
          nextPeriodEndBlock - nextPeriodStartBlock + 1
        } blocks to ${nextPeriodEndBlock - startBlock + 1} blocks`
      );

      // Ensure we don't go beyond the end of the next period
      if (startBlock > nextPeriodEndBlock) {
        console.debug(
          `⚠️  Start block ${startBlock} exceeds period end ${nextPeriodEndBlock}, using period start instead`
        );
        startBlock = nextPeriodStartBlock;
      }
    } catch (error) {
      throw new Error(`⚠️  Start block search failed: ${error.message}`);
    }
  }

  console.debug(
    `Scanning blocks ${startBlock} to ${nextPeriodEndBlock} for RewardsCalculatedForPeriod event`
  );

  // Walk through blocks from the optimized start point until the event is found
  for (
    let blockNumber = startBlock;
    blockNumber <= nextPeriodEndBlock;
    blockNumber++
  ) {
    console.debug(`🔍 Scanning block ${blockNumber}...`);
    try {
      const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
      const events = await api.query.system.events.at(blockHash);

      for (const { event } of events) {
        if (
          event.section === "workerNodePallet" &&
          event.method === "RewardsCalculatedForPeriod" &&
          event.data[0].toNumber() === periodIndex
        ) {
          console.debug(
            `Found RewardsCalculatedForPeriod event for period ${periodIndex} at block ${blockNumber}`
          );
          return blockHash.toString();
        }
      }
    } catch (error) {
      console.debug(`Could not query block ${blockNumber}: ${error.message}`);
      continue; // Skip this block and continue with the next one
    }
  }

  throw new Error(
    `No RewardsCalculatedForPeriod event found for period ${periodIndex} in the optimized search range ${startBlock}-${nextPeriodEndBlock}`
  );
}

async function findBlockBeforeRewardsCalculated(
  api,
  rewardsCalculatedBlockHash
) {
  try {
    console.log(`Finding block before RewardsCalculatedForPeriod event...`);

    // Get the block number from the hash
    const blockHeader = await api.rpc.chain.getHeader(
      rewardsCalculatedBlockHash
    );
    const blockNumber = blockHeader.number.toNumber();

    console.debug(`RewardsCalculatedForPeriod found at block ${blockNumber}`);

    // Look for the block BEFORE any EarnedRewardCalculated events
    // We need to keep going backwards until we find a block without the event
    const searchRange = 50; // Check up to 50 blocks before to ensure we find the initial state

    let lastBlockWithEvent = null;
    let initialBlockHash = null;

    for (let i = 1; i <= searchRange; i++) {
      const checkBlockNumber = blockNumber - i;
      if (checkBlockNumber < 0) break;

      try {
        const checkBlockHash = await api.rpc.chain.getBlockHash(
          checkBlockNumber
        );
        const events = await api.query.system.events.at(checkBlockHash);

        // Check if this block has EarnedRewardCalculated event
        let hasEvent = false;
        for (const { event } of events) {
          if (event.method === "EarnedRewardCalculated") {
            hasEvent = true;
            lastBlockWithEvent = checkBlockHash;
            console.debug(
              `Block ${checkBlockNumber} has EarnedRewardCalculated event`
            );
            break;
          }
        }

        // If this block doesn't have the event, we've found our initial state block
        if (!hasEvent) {
          initialBlockHash = checkBlockHash;
          console.debug(
            `Block ${checkBlockNumber} has NO EarnedRewardCalculated event - this is our initial state block`
          );
          break;
        }
      } catch (error) {
        console.debug(
          `Error checking block ${checkBlockNumber}: ${error.message}`
        );
        continue;
      }
    }

    if (initialBlockHash) {
      console.log(
        `✅ Found initial state block: ${initialBlockHash} (no EarnedRewardCalculated event)`
      );
      return initialBlockHash;
    } else if (lastBlockWithEvent) {
      // If we couldn't find a block without the event, use the last block with the event
      console.log(
        `⚠️  Could not find block without EarnedRewardCalculated event, using last block with event: ${lastBlockWithEvent}`
      );
      return lastBlockWithEvent;
    } else {
      // Fallback: use the block before RewardsCalculatedForPeriod
      const blockBeforeHash = await api.rpc.chain.getBlockHash(blockNumber - 1);
      console.log(
        `⚠️  Fallback: using block before RewardsCalculatedForPeriod: ${
          blockNumber - 1
        } (${blockBeforeHash})`
      );
      return blockBeforeHash;
    }
  } catch (error) {
    throw new Error(
      `Failed to find block before RewardsCalculatedForPeriod: ${error.message}`
    );
  }
}

async function getEligibleRounds(api, period, groupNs, blockHash) {
  try {
    // Based on the pallet logic:
    // total_eligible_rounds = NumberOfVotings - (NumberOfVotingsWithNomination - NumberOfOperatorVotingsWithNomination)

    // Query storage at the specific block hash using the .at() method
    const numberOfVotings = await api.query.workerNodePallet.numberOfVotings.at(
      blockHash,
      period,
      groupNs
    );
    const numberOfVotingsWithNomination =
      await api.query.workerNodePallet.numberOfVotingsWithNomination.at(
        blockHash,
        period,
        groupNs
      );
    // numberOfOperatorVotingsWithNomination might not exist, so we'll try to query it but handle errors gracefully
    let numberOfOperatorVotingsWithNomination = null;
    try {
      numberOfOperatorVotingsWithNomination =
        await api.query.workerNodePallet.numberOfOperatorVotingsWithNomination.at(
          blockHash,
          period, // RewardPeriodIndex first
          [ADDRESS, groupNs] // Tuple of (OperatorAccount, SolutionGroupNamespace)
        );
    } catch (error) {
      console.debug(
        `numberOfOperatorVotingsWithNomination query failed: ${error.message}`
      );
      numberOfOperatorVotingsWithNomination = null;
    }

    // Check if data exists and decode it
    // Note: numberOfVotings and numberOfVotingsWithNomination return BN directly, not Option
    if (!numberOfVotings || !numberOfVotingsWithNomination) {
      throw new Error(
        `Some voting data not found for period ${period}, group ${groupNs}. ` +
          `numberOfVotings: ${numberOfVotings ? "Some" : "None"}, ` +
          `numberOfVotingsWithNomination: ${
            numberOfVotingsWithNomination ? "Some" : "None"
          }`
      );
    }

    // numberOfOperatorVotingsWithNomination might not exist, so we'll handle it gracefully
    let operatorVotingsWithNomination = 0;
    try {
      if (numberOfOperatorVotingsWithNomination) {
        // Check if it's an Option type
        if (numberOfOperatorVotingsWithNomination.isNone !== undefined) {
          if (!numberOfOperatorVotingsWithNomination.isNone) {
            operatorVotingsWithNomination =
              numberOfOperatorVotingsWithNomination.unwrap().toNumber();
          }
        } else {
          // It's a direct value (like BN)
          operatorVotingsWithNomination =
            numberOfOperatorVotingsWithNomination.toNumber();
        }
      }
    } catch (error) {
      console.debug(
        `numberOfOperatorVotingsWithNomination not available, using 0: ${error.message}`
      );
      operatorVotingsWithNomination = 0;
    }

    // Decode the storage data using standard methods
    const totalVotings = numberOfVotings.toNumber();
    const totalVotingsWithNomination = numberOfVotingsWithNomination.toNumber();

    const totalEligibleRounds =
      totalVotings -
      (totalVotingsWithNomination - operatorVotingsWithNomination);

    console.debug("\nVoting eligibility stats");
    console.debug(`Querying for group: ${groupNs}, period: ${period}`);
    console.debug(
      `totalVotings=${totalVotings}, totalVotingsWithNomination=${totalVotingsWithNomination}, operatorVotingsWithNomination=${operatorVotingsWithNomination}`
    );
    console.debug(`calculated totalEligibleRounds=${totalEligibleRounds}`);

    return totalEligibleRounds;
  } catch (error) {
    throw new Error(`Failed to calculate eligible rounds: ${error.message}`);
  }
}

async function getVotesForAddress(api, period, groupNs, address, blockHash) {
  try {
    // Query the number of correct votes for the address in the specific period and group
    // Using VoteMetadata storage item: (groupNamespace, rewardPeriodIndex, operatorAccount) -> u32

    console.debug(
      `\nQuerying voteMetadata for group: ${groupNs}, period: ${period}, address: ${address}`
    );
    const voteMetadata = await api.query.workerNodePallet.voteMetadata.at(
      blockHash,
      groupNs,
      period,
      address
    );

    const votes = voteMetadata.toNumber();
    console.debug(
      `Found voting data for address ${address} in period ${period}, group ${groupNs}: ${votes} correct votes\n`
    );
    return votes;
  } catch (error) {
    throw new Error(
      `Failed to get votes for address ${address}: ${error.message}`
    );
  }
}

async function getSlaThreshold(api, period, groupNs, blockHash) {
  try {
    const groupInfo = await api.query.workerNodePallet.solutionsGroups.at(
      blockHash,
      groupNs
    );

    const group = groupInfo.unwrap().toHuman();
    // The SLA threshold might be stored in the group configuration
    // Look for slaVotingThreshold or similar field
    console.debug(
      `Found SLA threshold ${group.slaVotingThreshold} from group config`
    );
    return group.slaVotingThreshold;
  } catch (error) {
    throw new Error(
      `Could not find SLA threshold for group ${groupNs} - not found in group config or direct storage query: ${error.message}`
    );
  }
}

async function getRewardsForAddress(api, period, groupNs, address, blockHash) {
  try {
    // Query rewards earned by the address for the specific group
    // Based on the existing codebase, this uses the earnedRewards storage item

    const earnedRewards = await api.query.workerNodePallet.earnedRewards.at(
      blockHash,
      address,
      groupNs
    );

    console.debug(
      `Decoded rewards - Subscription: ${earnedRewards[0].toHuman()}, Voting: ${earnedRewards[1].toHuman()}`
    );
    return earnedRewards;
  } catch (error) {
    throw new Error(
      `Failed to get rewards for address ${address}: ${error.message}`
    );
  }
}

async function getGroupInfo(api, groupNs, blockHash) {
  // Get group information including SLA threshold
  try {
    const groupInfo = await api.query.workerNodePallet.solutionsGroups.at(
      blockHash,
      groupNs
    );

    return groupInfo.unwrap().toHuman();
  } catch (error) {
    throw new Error(
      `Failed to fetch group info for ${groupNs}: ${error.message}`
    );
  }
}

async function getPeriodInfo(api, periodIndex, blockHash) {
  // Get reward period information from ActiveRewardPeriodInfo
  try {
    const activeRewardPeriodInfo =
      await api.query.workerNodePallet.activeRewardPeriodInfo.at(blockHash);
    const currentPeriod = activeRewardPeriodInfo.toJSON();

    // Calculate the requested period's block range based on current period info
    // Calculate how many periods back from current period
    const periodsBack = currentPeriod.index - periodIndex;
    const periodStartBlock =
      currentPeriod.firstBlock - periodsBack * currentPeriod.length;
    const periodEndBlock = periodStartBlock + currentPeriod.length - 1;

    // Validate calculations
    if (isNaN(periodStartBlock) || isNaN(periodEndBlock)) {
      throw new Error(
        `Invalid period block calculation: periodStartBlock=${periodStartBlock}, periodEndBlock=${periodEndBlock}. ` +
          `Current period: ${currentPeriod.index}, requested period: ${periodIndex}, period length: ${currentPeriod.length}`
      );
    }

    return {
      index: periodIndex,
      start: periodStartBlock,
      end: periodEndBlock,
      length: currentPeriod.length,
      firstBlock: periodStartBlock,
    };
  } catch (error) {
    throw new Error(
      `Failed to fetch period info for ${periodIndex}: ${error.message}`
    );
  }
}

async function getAllGroupsSystemVotingRoundsCount(
  api,
  periodIndex,
  blockHash
) {
  // Count system voting rounds for all groups in a specific period
  try {
    console.debug(
      `Counting system voting rounds for all groups in period ${periodIndex}...`
    );

    // Get the last block of the reward period
    const periodInfo = await getPeriodInfo(api, periodIndex, blockHash);
    const lastBlockOfPeriod = periodInfo.end;

    console.debug(
      `Querying system voting rounds for all groups at last block of period: ${lastBlockOfPeriod}`
    );

    // Convert block number to block hash
    const lastBlockHash = await api.rpc.chain.getBlockHash(lastBlockOfPeriod);
    console.debug(
      `Last block hash for all groups: ${lastBlockHash.toString()}`
    );

    // Query system voting rounds for all groups using the correct storage definition
    // StorageDoubleMap: (RewardPeriodIndex, VotingRoundKey) -> VotingRoundInfo
    // For all groups, we only specify the period index
    const allSystemVotingRounds =
      await api.query.workerNodePallet.systemVotingRound.entriesAt(
        lastBlockHash, // Query at the end of the period (block hash)
        periodIndex // First key: RewardPeriodIndex (only)
      );

    const count = allSystemVotingRounds.length;
    console.debug(
      `Found ${count} total system voting rounds for period ${periodIndex} across all groups at block ${lastBlockOfPeriod}`
    );

    return count;
  } catch (error) {
    throw new Error(
      `Failed to count total system voting rounds: ${error.message}`
    );
  }
}

/// Helper to query the indexer for rewards calculation block
async function queryIndexerForRewardsBlock(indexerUrl, periodIndex, api) {
  try {
    const query = {
      query: `query { 
        events(
          where: {
            name_eq: "WorkerNodePallet.RewardsCalculatedForPeriod"
          }, 
          orderBy: blockNumber_DESC
        ) { 
          name 
          blockNumber 
        } 
      }`,
    };

    const response = await fetch(indexerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(query),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (data.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    if (!data.data || !data.data.events || data.data.events.length === 0) {
      return null;
    }

    // Get the period info to determine the block range
    const activeRewardPeriodInfo =
      await api.query.workerNodePallet.activeRewardPeriodInfo();
    const currentPeriod = activeRewardPeriodInfo.toJSON();

    // Calculate the period boundaries for the requested period and the next period
    const periodLength = currentPeriod.length;
    const periodStartBlock =
      currentPeriod.firstBlock -
      (currentPeriod.index - periodIndex) * periodLength;
    const periodEndBlock = periodStartBlock + periodLength - 1;

    // Calculate the start block of the next period (period 614 + 1 = period 615)
    const nextPeriodStartBlock = periodStartBlock + periodLength;

    console.log(
      `Period ${periodIndex} block range: ${periodStartBlock} to ${periodEndBlock}`
    );
    console.log(
      `Next period ${periodIndex + 1} starts at block: ${nextPeriodStartBlock}`
    );

    // We need to find the RewardsCalculatedForPeriod event that happens AFTER the next period starts
    // This means the event should be after nextPeriodStartBlock
    const searchStartBlock = nextPeriodStartBlock; // Event must be after next period starts
    const searchEndBlock = searchStartBlock + 2000; // Search up to 2000 blocks after

    console.log(
      `Searching for RewardsCalculatedForPeriod event after next period starts: blocks ${searchStartBlock} to ${searchEndBlock}`
    );

    // Find the event that falls within the search range (after next period starts)
    for (const event of data.data.events) {
      const blockNumber = event.blockNumber;
      if (blockNumber >= searchStartBlock && blockNumber <= searchEndBlock) {
        console.log(
          `✅ Found RewardsCalculatedForPeriod event for period ${periodIndex} at block ${blockNumber} (after next period starts)`
        );
        return blockNumber;
      }
    }

    console.log(
      `No RewardsCalculatedForPeriod event found within period ${periodIndex} block range`
    );
    return null;
  } catch (error) {
    throw new Error(`Indexer query failed: ${error.message}`);
  }
}

/// Main workflow
async function main() {
  const provider = new WsProvider(NODE_URL);
  const api = await ApiPromise.create({
    provider,
    typesBundle: avnTypes,
  });

  try {
    console.log(`Connecting to ${NODE_URL}...`);
    await api.isReady;
    console.log("Connected to Energy Web X parachain");

    // Validate input parameters
    await validateInput(api);

    // Step 1: find block where rewards for the period were calculated
    let blockHash;

    if (SPECIFIC_BLOCK_HASH) {
      console.log(`\nUsing provided block hash: ${SPECIFIC_BLOCK_HASH}`);
      console.log("Verifying RewardsCalculatedForPeriod event...");

      try {
        const events = await api.query.system.events.at(SPECIFIC_BLOCK_HASH);
        let eventFound = false;

        for (const { event } of events) {
          if (
            event.section === "workerNodePallet" &&
            event.method === "RewardsCalculatedForPeriod" &&
            event.data[0].toNumber() === REWARD_PERIOD_INDEX
          ) {
            eventFound = true;
            break;
          }
        }

        if (!eventFound) {
          throw new Error(
            `RewardsCalculatedForPeriod event for period ${REWARD_PERIOD_INDEX} not found in the provided block ${SPECIFIC_BLOCK_HASH}`
          );
        }

        blockHash = SPECIFIC_BLOCK_HASH;
        console.log(
          `✅ Verified RewardsCalculatedForPeriod event for period ${REWARD_PERIOD_INDEX} at block ${blockHash}`
        );
      } catch (error) {
        throw new Error(
          `Failed to verify RewardsCalculatedForPeriod event in provided block ${SPECIFIC_BLOCK_HASH}: ${error.message}`
        );
      }
    } else if (process.env.INDEXER_URL) {
      // Priority 2: Query the indexer for the block number
      console.log(
        `\nQuerying indexer at ${process.env.INDEXER_URL} for RewardsCalculatedForPeriod event...`
      );

      try {
        const indexerBlockNumber = await queryIndexerForRewardsBlock(
          process.env.INDEXER_URL,
          REWARD_PERIOD_INDEX,
          api
        );

        if (indexerBlockNumber) {
          console.log(
            `✅ Found block number ${indexerBlockNumber} from indexer within period ${REWARD_PERIOD_INDEX} range`
          );

          // Use the block directly from the indexer
          blockHash = await api.rpc.chain.getBlockHash(indexerBlockNumber);
          console.log(`✅ Using block hash from indexer: ${blockHash}`);
        } else {
          throw new Error(
            "Indexer query returned no results within the period range"
          );
        }
      } catch (error) {
        console.log(
          `⚠️  Indexer query failed: ${error.message}, falling back to blockchain search`
        );
        console.log(
          `\nSearching for RewardsCalculatedForPeriod event for period ${REWARD_PERIOD_INDEX}...`
        );
        console.log(
          "🔍 Using optimized search method (counts SystemVotingRounds in previous period)"
        );
        blockHash = await findBlockForPeriod(api, REWARD_PERIOD_INDEX);
        console.log(
          `Found block for period ${REWARD_PERIOD_INDEX}:`,
          blockHash
        );
      }
    } else {
      // Priority 3: Fallback to blockchain search
      console.log(
        `\nSearching for RewardsCalculatedForPeriod event for period ${REWARD_PERIOD_INDEX}...`
      );
      console.log(
        "🔍 Using optimized search method (counts SystemVotingRounds in previous period)"
      );

      blockHash = await findBlockForPeriod(api, REWARD_PERIOD_INDEX);
      console.log(`Found block for period ${REWARD_PERIOD_INDEX}:`, blockHash);
    }

    // Step 2: get additional context information
    let groupInfo, periodInfo;

    try {
      groupInfo = await getGroupInfo(api, GROUP_NAMESPACE, blockHash);
    } catch (error) {
      throw Error(`❌ Failed to get group info: ${error.message}`);
    }

    try {
      periodInfo = await getPeriodInfo(api, REWARD_PERIOD_INDEX, blockHash);
    } catch (error) {
      throw Error(`❌ Failed to get period info: ${error.message}`);
    }

    // Step 3: Find the block before RewardsCalculatedForPeriod for initial state
    console.log(
      "\nFinding block before RewardsCalculatedForPeriod for initial state..."
    );

    let initialBlockHash;
    try {
      initialBlockHash = (
        await findBlockBeforeRewardsCalculated(api, blockHash)
      ).toHuman();
      console.log(`✅ Found initial block: ${initialBlockHash}`);
    } catch (error) {
      throw Error(`❌ Failed to find initial block: ${error.message}`);
    }

    // Step 4: query historical state at both blocks
    console.log("\nQuerying historical state...");

    let eligibleRounds, votes, slaPercentage, initialRewards, finalRewards;
    try {
      eligibleRounds = await getEligibleRounds(
        api,
        REWARD_PERIOD_INDEX,
        GROUP_NAMESPACE,
        initialBlockHash || blockHash
      );
    } catch (error) {
      throw Error(`❌ Failed to get eligible rounds: ${error.message}`);
    }

    try {
      votes = await getVotesForAddress(
        api,
        REWARD_PERIOD_INDEX,
        GROUP_NAMESPACE,
        ADDRESS,
        initialBlockHash || blockHash
      );
    } catch (error) {
      throw Error(`❌ Failed to get votes: ${error.message}`);
    }

    try {
      slaPercentage = await getSlaThreshold(
        api,
        REWARD_PERIOD_INDEX,
        GROUP_NAMESPACE,
        initialBlockHash || blockHash
      );
    } catch (error) {
      throw Error(`❌ Failed to get SLA threshold: ${error.message}`);
    }

    try {
      // Get initial rewards at the block before RewardsCalculatedForPeriod
      if (initialBlockHash) {
        initialRewards = await getRewardsForAddress(
          api,
          REWARD_PERIOD_INDEX,
          GROUP_NAMESPACE,
          ADDRESS,
          initialBlockHash
        );
        console.log(`✅ Got initial rewards: ${initialRewards.toHuman()}`);
      } else {
        initialRewards = 0;
        console.log(`⚠️  No initial block found, assuming initial rewards: 0`);
      }
    } catch (error) {
      throw Error(`❌ Failed to get initial rewards: ${error.message}`);
    }

    try {
      // Get final rewards at the block with RewardsCalculatedForPeriod
      finalRewards = await getRewardsForAddress(
        api,
        REWARD_PERIOD_INDEX,
        GROUP_NAMESPACE,
        ADDRESS,
        blockHash
      );
      console.log(`✅ Got final rewards: ${finalRewards.toHuman()}`);
    } catch (error) {
      throw Error(`❌ Failed to get final rewards: ${error.message}`);
    }

    // Get system voting rounds count for all groups
    let allGroupsSystemVotingRounds = null;
    try {
      allGroupsSystemVotingRounds = await getAllGroupsSystemVotingRoundsCount(
        api,
        REWARD_PERIOD_INDEX,
        blockHash
      );
      console.log(
        `✅ Got total system voting rounds across all groups: ${allGroupsSystemVotingRounds}`
      );
    } catch (error) {
      throw Error(
        `❌ Failed to get total system voting rounds: ${error.message}`
      );
    }

    // Calculate the actual rewards earned during this period
    let periodRewards = null;
    if (initialRewards !== null && finalRewards !== null) {
      // Handle BN tuple values properly for subtraction
      // Both are BN tuples [subscriptionRewards, votingRewards]
      const subscriptionPeriodRewards = finalRewards[0].sub(initialRewards[0]);
      const votingPeriodRewards = finalRewards[1].sub(initialRewards[1]);
      periodRewards = [subscriptionPeriodRewards, votingPeriodRewards];

      console.log(
        `✅ Calculated period rewards - Subscription: ${subscriptionPeriodRewards}, Voting: ${votingPeriodRewards}`
      );
    }

    // Step 4: derive SLA check
    let voteRatio = null;
    let meetsSla = null;
    if (eligibleRounds && votes !== null && slaPercentage !== null) {
      voteRatio = (votes / eligibleRounds) * 100;

      // Convert slaPercentage from string (e.g., "60.00%") to number
      let slaThresholdNumber = parseFloat(slaPercentage.replace("%", ""));

      meetsSla = voteRatio >= slaThresholdNumber;

      // Debug SLA calculation
      console.debug(`SLA Calculation Debug:`);
      console.debug(`  votes: ${votes} (type: ${typeof votes})`);
      console.debug(
        `  eligibleRounds: ${eligibleRounds} (type: ${typeof eligibleRounds})`
      );
      console.debug(`  voteRatio: ${voteRatio} (type: ${typeof voteRatio})`);
      console.debug(
        `  slaPercentage: ${slaPercentage} (type: ${typeof slaPercentage})`
      );
      console.debug(
        `  slaThresholdNumber: ${slaThresholdNumber} (type: ${typeof slaThresholdNumber})`
      );
      console.debug(
        `  meetsSla calculation: ${voteRatio} >= ${slaThresholdNumber} = ${meetsSla}`
      );
    }

    // Step 5: output results
    console.log("\n" + "=".repeat(60));
    console.log("REWARD PERIOD ANALYSIS REPORT");
    console.log("=".repeat(60));
    console.log("Reward Period Index:", REWARD_PERIOD_INDEX);
    console.log("Group Namespace:", GROUP_NAMESPACE);
    console.log("Address:", ADDRESS);
    console.log("-".repeat(60));

    if (periodInfo) {
      console.log("Period Info:", JSON.stringify(periodInfo, null, 2));
    }

    if (groupInfo) {
      console.log("Group Info:", JSON.stringify(groupInfo, null, 2));
    }

    console.log("-".repeat(60));
    console.log(
      "Eligible Rounds:",
      eligibleRounds !== null ? eligibleRounds : "N/A"
    );
    console.log("Votes Submitted:", votes !== null ? votes : "N/A");
    console.log(
      "SLA Threshold %:",
      slaPercentage !== null ? slaPercentage : "N/A"
    );

    if (voteRatio !== null) {
      console.log("Vote Ratio %:", voteRatio.toFixed(2));
      console.log("Meets SLA:", meetsSla ? "✅ YES" : "❌ NO");
    } else {
      console.log("Vote Ratio %: N/A (insufficient data)");
      console.log("Meets SLA: N/A");
    }
    console.log("-".repeat(60));

    // Calculate EWT values for all reward amounts
    const initialSubscriptionEWT = initialRewards[0].div(
      new BN(10).pow(new BN(18))
    );
    const initialVotingEWT = initialRewards[1].div(new BN(10).pow(new BN(18)));
    const finalSubscriptionEWT = finalRewards[0].div(
      new BN(10).pow(new BN(18))
    );
    const finalVotingEWT = finalRewards[1].div(new BN(10).pow(new BN(18)));
    const subscriptionRewardsEWT = periodRewards[0].div(
      new BN(10).pow(new BN(18))
    );
    const votingRewardsEWT = periodRewards[1].div(new BN(10).pow(new BN(18)));

    // Get the remainder for decimal precision
    const subscriptionRemainder = periodRewards[0].mod(
      new BN(10).pow(new BN(18))
    );
    const votingRemainder = periodRewards[1].mod(new BN(10).pow(new BN(18)));

    // Format with decimal places (6 decimal precision)
    const subscriptionDecimal = subscriptionRemainder
      .div(new BN(10).pow(new BN(12)))
      .toString()
      .padStart(6, "0");
    const votingDecimal = votingRemainder
      .div(new BN(10).pow(new BN(12)))
      .toString()
      .padStart(6, "0");

    console.log("Initial Rewards:");
    console.log(
      `  Subscription: ${initialRewards[0].toString()} (${initialSubscriptionEWT.toString()} EWT)`
    );
    console.log(
      `  Voting: ${initialRewards[1].toString()} (${initialVotingEWT.toString()} EWT)`
    );

    console.log("Final Rewards (after distribution):");
    console.log(
      `  Subscription: ${finalRewards[0].toString()} (${finalSubscriptionEWT.toString()} EWT)`
    );
    console.log(
      `  Voting: ${finalRewards[1].toString()} (${finalVotingEWT.toString()} EWT)`
    );

    console.log("Period Rewards Earned:");
    console.log(
      `  Subscription: ${periodRewards[0].toString()} (${subscriptionRewardsEWT.toString()}.${subscriptionDecimal} EWT)`
    );
    console.log(
      `  Voting: ${periodRewards[1].toString()} (${votingRewardsEWT.toString()}.${votingDecimal} EWT)`
    );
    console.log("=".repeat(60));
  } catch (error) {
    console.error("Error:", error.message);
    console.error("Stack:", error.stack);
  } finally {
    await api.disconnect();
    console.log("\nDisconnected from parachain");
  }
}

// Run the script
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
