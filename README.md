# Report Rewards Tool

A Node.js tool for analyzing reward periods and calculating earned rewards for addresses in the Energy Web X parachain worker node system.

## What This Tool Does

This tool analyzes reward periods for addresses subscribed to solution groups in the Energy Web X parachain. It:

1. **Validates Input Parameters** - Ensures all required parameters are provided and valid
2. **Checks Subscription Status** - Verifies that the address was subscribed to the specified group during the requested period
3. **Finds Reward Calculation Blocks** - Locates the blockchain blocks where rewards were calculated for the period
4. **Calculates Historical State** - Queries the blockchain state before and after reward distribution
5. **Analyzes Performance** - Calculates voting performance and SLA compliance
6. **Reports Results** - Provides a comprehensive analysis of rewards earned during the period

## Features

- ✅ **Input Validation** - Validates all required parameters and subscription status
- ✅ **Historical Block Analysis** - Finds the exact blocks where rewards were calculated
- ✅ **Reward Calculation** - Calculates subscription and voting rewards earned during the period
- ✅ **SLA Analysis** - Determines if the address met the Service Level Agreement requirements
- ✅ **Performance Metrics** - Shows voting statistics and eligibility information
- ✅ **EWT Conversion** - Displays rewards in both raw units and EWT (Energy Web Token)

## Prerequisites

- Node.js (v16 or higher)
- Access to Energy Web X parachain RPC endpoint

## Installation

1. Clone or download this repository
2. Install dependencies:
   ```bash
   npm install
   ```

## Configuration

Create a `.env` file in the project root with the following variables:

```env
# Required Parameters
REWARD_PERIOD_INDEX=614
GROUP_NAMESPACE=smartflow.v2
ADDRESS=5D2csUmBkLadib8ZM2guw28tXs2nMMAGS4K9RK9ApRdb6F6R

# Optional Parameters
NODE_URL=wss://public-rpc.mainnet.energywebx.com
SPECIFIC_BLOCK_HASH=0xafe20ffbab4dea653cb2c8ac1230122ca6a43c4932f0fbd83214230ec3db1326
INDEXER_URL=https://ewx-indexers.mainnet.energywebx.com/core/graphql
```

### Parameter Descriptions

| Parameter             | Required | Description                                                                                     |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `REWARD_PERIOD_INDEX` | ✅       | The reward period to analyze (positive integer)                                                 |
| `GROUP_NAMESPACE`     | ✅       | The solution group namespace (e.g., "smartflow.v2")                                             |
| `ADDRESS`             | ✅       | The address to analyze (SS58 format)                                                            |
| `NODE_URL`            | ❌       | RPC endpoint URL (defaults to mainnet)                                                          |
| `SPECIFIC_BLOCK_HASH` | ❌       | Specific block hash to use (if not provided, tool will search for the reward calculation block) |
| `INDEXER_URL`         | ❌       | GraphQL indexer URL for fast block discovery (recommended for production use)                   |

## Usage

### Basic Usage

```bash
npm start
```

### With Custom Parameters

```bash
REWARD_PERIOD_INDEX=578 GROUP_NAMESPACE=smartflow.v2 ADDRESS=5D2csUmBkLadib8ZM2guw28tXs2nMMAGS4K9RK9ApRdb6F6R npm start
```

### With Specific Block Hash

```bash
SPECIFIC_BLOCK_HASH=0xafe20ffbab4dea653cb2c8ac1230122ca6a43c4932f0fbd83214230ec3db1326 npm start
```

### With Indexer (Recommended for Production)

```bash
INDEXER_URL=https://ewx-indexers.mainnet.energywebx.com/core/graphql npm start
```

### With Both Indexer and Specific Block Hash

```bash
INDEXER_URL=https://ewx-indexers.mainnet.energywebx.com/core/graphql SPECIFIC_BLOCK_HASH=0xafe20ffbab4dea653cb2c8ac1230122ca6a43c4932f0fbd83214230ec3db1326 npm start
```

## Output

The tool provides a comprehensive report including:

### Validation Results

- ✅ Parameter validation status
- ✅ Subscription verification with stake amount

### Period Information

- Period index, start/end blocks, and length
- Group configuration and SLA thresholds

### Performance Analysis

- Eligible voting rounds
- Votes submitted
- Vote ratio percentage
- SLA compliance status

### Reward Breakdown

- **Initial Rewards**: Rewards before the period
- **Final Rewards**: Rewards after the period
- **Period Rewards**: Net rewards earned during the period
- **EWT Conversion**: All amounts displayed in both raw units and EWT

### Example Output

```
------------------------------------------------------------
Eligible Rounds: 87
Votes Submitted: 61
SLA Threshold %: 60.00%
Vote Ratio %: 70.11
Meets SLA: ✅ YES
------------------------------------------------------------
Initial Rewards:
  Subscription: 7982644892450463358 (7 EWT)
  Voting: 30299138028873089534 (30 EWT)
Final Rewards (after distribution):
  Subscription: 8206437276591532332 (8 EWT)
  Voting: 31834395275802910556 (31 EWT)
Period Rewards Earned:
  Subscription: 223792384141068974 (0.223792 EWT)
  Voting: 1535257246929821022 (1.535257 EWT)
============================================================
```

## How It Works

### 1. Input Validation

- Validates all required parameters
- Checks if the address was subscribed to the group during the specified period
- Queries the `SolutionGroupStakeRecords` storage to verify subscription status

### 2. Block Discovery

The tool uses a three-priority system to find the block where `RewardsCalculatedForPeriod` event was emitted:

**Priority 1: SPECIFIC_BLOCK_HASH** (if provided)

- Uses the provided block hash directly after verification

**Priority 2: INDEXER_URL** (if provided)

- Queries the GraphQL indexer for `WorkerNodePallet.RewardsCalculatedForPeriod` events
- Finds the event that occurs after the start of the next period (period 614 + 1 = period 615)
- **Fast and efficient** - finds the correct block in seconds

**Priority 3: Blockchain Search** (fallback)

- Uses optimized search algorithm that counts `SystemVotingRounds` from previous periods
- **Slower but reliable** - scans blockchain blocks sequentially

- Locates the initial state block (before any `EarnedRewardCalculated` events)

### 3. Historical State Analysis

- Queries blockchain state at both initial and final blocks
- Calculates eligible voting rounds using pallet storage queries
- Retrieves voting performance data for the address

### 4. Reward Calculation

- Compares rewards before and after the period
- Calculates net rewards earned during the period
- Converts amounts to EWT for human-readable display

### 5. SLA Analysis

- Calculates vote ratio percentage
- Compares against group SLA threshold
- Determines compliance status

## Technical Details

The tool analyzes blockchain data by:

1. **Querying Storage Items** - Accesses various pallet storage items to gather period, subscription, and reward information
2. **Event Monitoring** - Uses three-priority system to find `RewardsCalculatedForPeriod` events:
   - **Indexer Query**: Fast GraphQL queries to external indexer
   - **Blockchain Search**: Direct blockchain scanning as fallback
3. **Historical State Analysis** - Compares blockchain state before and after reward distribution
4. **Performance Calculation** - Computes voting statistics and SLA compliance metrics

## Performance Considerations

- **With INDEXER_URL**: ⚡ **Fast** (~5-10 seconds) - Recommended for production use
- **Without INDEXER_URL**: 🐌 **Slow** (could take hours) - Only for development/testing
- **With SPECIFIC_BLOCK_HASH**: ⚡ **Instant** - When you know the exact block

## License

This tool is provided as-is for analyzing Energy Web X parachain reward periods.

See [LICENSE](LICENSE) for more details.
