// SPDX-License-Identifier: MIT
pragma solidity  ^0.8.23;

//import "https://github.com/Uniswap/permit2/blob/0ded3a98b83ccce4cf4eda7f7d4c974b1d6f09f9/src/Permit2.sol";
import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/token/ERC20/utils/SafeERC20.sol";
import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol"; // Chainlink Automation Interface
import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import  "@aave/core-v3/contracts/interfaces/IPool.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@1inch/solidity-utils/contracts/libraries/AddressLib.sol"; // Replace with the actual library path
//import "@1inch/solidity-utils/contracts/interfaces/IWETH.sol";
import "@1inch/solidity-utils/contracts/interfaces/IDaiLikePermit.sol";


library ProtocolLib {
    using AddressLib for Address;

    enum Protocol {
        UniswapV2,
        UniswapV3,
        Curve
    }

    uint256 private constant _PROTOCOL_OFFSET = 253;
    uint256 private constant _WETH_UNWRAP_FLAG = 1 << 252;
    uint256 private constant _WETH_NOT_WRAP_FLAG = 1 << 251;
    uint256 private constant _USE_PERMIT2_FLAG = 1 << 250;

    function protocol(Address self) internal pure returns(Protocol) 
    {
        // there is no need to mask because protocol is stored in the highest 3 bits
        return Protocol((Address.unwrap(self) >> _PROTOCOL_OFFSET));
    }

    function shouldUnwrapWeth(Address self) internal pure returns(bool) {
        return self.getFlag(_WETH_UNWRAP_FLAG);
    }

    function shouldWrapWeth(Address self) internal pure returns(bool) {
        return !self.getFlag(_WETH_NOT_WRAP_FLAG);
    }

    function usePermit2(Address self) internal pure returns(bool) {
        return self.getFlag(_USE_PERMIT2_FLAG);
    }

    function addressForPreTransfer(Address self) internal view returns(address) {
        if (protocol(self) == Protocol.UniswapV2) {
            return self.get();
        }
        return address(this);
    }
}

 // @title Interface for making arbitrary calls during swap
 interface IAggregationExecutor {
    struct SwapDescription {
         IERC20 srcToken;
        IERC20 dstToken;
        address payable srcReceiver;
        address payable dstReceiver;
        uint256 amount;
        uint256 minReturnAmount;
        uint256 flags;
    }

    function execute(address msgSender, uint256 amount,  bytes calldata data) external payable returns(uint256); 
 }

interface IEIP712 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IERC20Metadata is IERC20 {
    function decimals() external view returns (uint8);
}

interface IUniswapV3Factory {
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view returns (address pool);
}


interface ICurveRegistry {
    function get_pool(address tokenA, address tokenB) external view returns (address);
}

interface IUniswapV3Pool {
    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    );

    function liquidity() external view returns (uint128);

    /// @notice Emitted by the pool for any swaps between token0 and token1
    /// @param sender The address that initiated the swap call, and that received the callback
    /// @param recipient The address that received the output of the swap
    /// @param amount0 The delta of the token0 balance of the pool
    /// @param amount1 The delta of the token1 balance of the pool
    /// @param sqrtPriceX96 The sqrt(price) of the pool after the swap, as a Q64.96
    /// @param liquidity The liquidity of the pool after the swap
    /// @param tick The log base 1.0001 of price of the pool after the swap
    event Swap(
        address indexed sender,
        address indexed recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    );

    /// @notice Swap token0 for token1, or token1 for token0
    /// @dev The caller of this method receives a callback in the form of IUniswapV3SwapCallback#uniswapV3SwapCallback
    /// @param recipient The address to receive the output of the swap
    /// @param zeroForOne The direction of the swap, true for token0 to token1, false for token1 to token0
    /// @param amountSpecified The amount of the swap, which implicitly configures the swap as exact input (positive), or exact output (negative)
    /// @param sqrtPriceLimitX96 The Q64.96 sqrt price limit. If zero for one, the price cannot be less than this
    /// value after the swap. If one for zero, the price cannot be greater than this value after the swap
    /// @param data Any data to be passed through to the callback
    /// @return amount0 The delta of the balance of token0 of the pool, exact when negative, minimum when positive
    /// @return amount1 The delta of the balance of token1 of the pool, exact when negative, minimum when positive
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    /// @notice The first of the two tokens of the pool, sorted by address
    /// @return The token contract address
    function token0() external view returns (address);

    /// @notice The second of the two tokens of the pool, sorted by address
    /// @return The token contract address
    function token1() external view returns (address);

    /// @notice The pool's fee in hundredths of a bip, i.e. 1e-6
    /// @return The fee
    function fee() external view returns (uint24);
}

interface IUniswapV3SwapCallback {
    /// @notice Called to `msg.sender` after executing a swap via IUniswapV3Pool#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// The caller of this method must be checked to be a UniswapV3Pool deployed by the canonical UniswapV3Factory.
    /// amount0Delta and amount1Delta can both be 0 if no tokens were swapped.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the IUniswapV3PoolActions#swap call
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external;
}

interface IWETH is IERC20 {
    event Deposit(address indexed dst, uint256 wad);

    event Withdrawal(address indexed src, uint256 wad);

    function deposit() external payable;

    function withdraw(uint256 amount) external;
}

interface ISignatureTransfer is IEIP712 {

    error InvalidAmount(uint256 maxAmount);
    error LengthMismatch();

    event UnorderedNonceInvalidation(address indexed owner, uint256 word, uint256 mask);

    struct TokenPermissions {
        // ERC20 token address
        address token;
        // the maximum amount that can be spent
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        // deadline on the permit signature
        uint256 deadline;
    }


    struct ISignatureTransferDetails {
        // recipient address
        address to;
        // spender requested amount
        uint256 requestedAmount;
    }

    struct PermitBatchTransferFrom {
        TokenPermissions[] permitted;
        uint256 nonce;
        uint256 deadline;
    }

    function nonceBitmap(address, uint256) external view returns (uint256);

    function permitTransferFrom(
        PermitTransferFrom memory permit,
        ISignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;

    function permitWitnessTransferFrom(
        PermitTransferFrom memory permit,
        ISignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;

    
    function permitTransferFrom(
        PermitBatchTransferFrom memory permit,
        ISignatureTransferDetails[] calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;

    
    function permitWitnessTransferFrom(
        PermitBatchTransferFrom memory permit,
        ISignatureTransferDetails[] calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;

    
    function invalidateUnorderedNonces(uint256 wordPos, uint256 mask) external;
}


interface IAllowanceTransfer is IEIP712 {
    error AllowanceExpired(uint256 deadline);
    error InsufficientAllowance(uint256 amount);
    error ExcessiveInvalidation();

    event NonceInvalidation(
        address indexed owner, address indexed token, address indexed spender, uint48 newNonce, uint48 oldNonce
    );

    event Approval(
        address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration
    );

    event Permit(
        address indexed owner,
        address indexed token,
        address indexed spender,
        uint160 amount,
        uint48 expiration,
        uint48 nonce
    );

    event Lockdown(address indexed owner, address token, address spender);

    struct PermitDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct PermitSingle {
        PermitDetails details;
        address spender;
        uint256 sigDeadline;
    }

    struct PermitBatch {
        PermitDetails[] details;
        address spender;
        uint256 sigDeadline;
    }


    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct TokenSpenderPair {
        address token;
        address spender;
    }

    struct AllowanceTransferDetails {
        address from;
        address to;
        uint160 amount;
        address token;
    }

    function allowance(address user, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);

    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
    function permit(address owner, PermitSingle memory permitSingle, bytes calldata signature) external;
    function permit(address owner, PermitBatch memory permitBatch, bytes calldata signature) external;

    function transferFrom(address from, address to, uint160 amount, address token) external;
    function transferFrom(AllowanceTransferDetails[] calldata transferDetails) external;
    function lockdown(TokenSpenderPair[] calldata approvals) external;
    function invalidateNonces(address token, address spender, uint48 newNonce) external;
}

 interface IPermit2 is ISignatureTransfer, IAllowanceTransfer {
// IPermit2 unifies the two interfaces so users have maximal flexibility with their approval.
}

interface GenericRouter  {
   
    struct SwapDescription {
        IERC20 srcToken;
        IERC20 dstToken;
        address payable srcReceiver;
        address payable dstReceiver;
        uint256 amount;
        uint256 minReturnAmount;
        uint256 flags;
    }
    
    function swap(
        IAggregationExecutor executor,
       SwapDescription calldata desc,
        bytes memory routeData
    ) external payable returns (uint256 returnAmount, uint256 spentAmount); 

   function unoswapTo(
    Address to,
    Address token,
    uint256 amount,
    uint256 minReturn,
    Address dex
) external returns(uint256 returnAmount);
}

contract AdvancedArbitrage1 is  Ownable, AutomationCompatibleInterface, FlashLoanSimpleReceiverBase, ReentrancyGuard{
    using SafeERC20 for IERC20; // Enables SafeERC20 functions for IERC20 tokens
   GenericRouter public genericRouter = GenericRouter(0x111111125421cA6dc452d289314280a0f8842A65);
     using ECDSA for bytes32;
    using SafeMath for uint256;
    using AddressLib for Address;
    using SafeERC20 for IWETH;
      using ProtocolLib for Address;
    mapping (address => mapping (IERC20 => uint256)) public tokenBalancesByUser;
    address public curveRegistry = 0x5ffe7FB82894076ECB99A30D6A32e969e6e35E98; // Replace with the correct Curve registry address
    uint256 private constant _PROTOCOL_OFFSET = 253;
    bytes4 constant isValidSignatureSelector =  0x1626ba7e;
    IPermit2 public immutable permit2;
    IERC20 public usdtToken;  // USDT token instance

    struct SwapDescription {
        IERC20 srcToken;
        IERC20 dstToken;
        address payable srcReceiver;
        address payable dstReceiver;
        uint256 amount;
        uint256 minReturnAmount;
        uint256 flags;
    }
    // Events to track off-chain updates
    event BatchExecuted(uint256 currentOffset, uint256 cumulativeReturnAmount);
  event PartialExecution(uint256 cumulativeReturnAmount);
 //event FlashLoanExecuted(uint256 profit);

   event SwapExecuted(uint256 returnAmount, uint256 spentAmount);
   event FlashLoanExecuted(uint256 profit);
 // Event for debugging
    event DecodedData(
        uint256 amount,
        address srcToken,
        address dstToken,
        address srcReceiver,
        address dstReceiver,
        uint256 minReturnAmount,
        uint256 flags,
        bytes routeData
    );
     
     uint256 public constant MIN_SLIPPAGE = 30; // 0.3% in basis points
    uint256 public constant MAX_SLIPPAGE = 200; // 2% in basis points
     uint256 public lastUpdated;
      uint256 public constant MIN_UPDATE_INTERVAL = 30; // 30 seconds
       

  constructor(
    address _owner,
    address _addressesProvider,
   address permit2Address
    )Ownable(_owner) FlashLoanSimpleReceiverBase(IPoolAddressesProvider(_addressesProvider)) {
       permit2 = IPermit2(permit2Address);
        lastUpdated = block.timestamp; // Set the initial timestamp
    }

  function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory) {
        upkeepNeeded = (block.timestamp - lastUpdated) > MIN_UPDATE_INTERVAL;
    }


 function performUpkeep(bytes calldata) external override {
        require((block.timestamp - lastUpdated) > MIN_UPDATE_INTERVAL, "Update interval not met");
        lastUpdated = block.timestamp;
    }

// Function to verify the signature
    function isValidSignature(bytes32 _hash, bytes memory _signature) 
        public 
        view 
 
        returns (bytes4 magicValue) 
    {
        // Recreate the signed message hash
        bytes32 messageHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", _hash));

        // Recover the signer from the signature
        address signer = recoverSigner(messageHash, _signature);

        // Check if the signer matches `msg.sender`
        if (signer == owner()) {
            return 0x1626ba7e; // Return the valid magic value
        } else {
            return 0x00000000; // Return invalid magic value
        }
    }

    // Helper function to recover the signer address
    function recoverSigner(bytes32 messageHash, bytes memory signature) 
        internal 
        pure 
        returns (address) 
    {
        bytes32 r;
        bytes32 s;
        uint8 v;

        // Check signature length
        if (signature.length != 65) {
            return address(0);
        }

        // Extract r, s, and v from the signature
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }

        // Adjust v if needed
        if (v < 27) {
            v += 27;
        }

        // Ensure v is valid
        if (v != 27 && v != 28) {
            return address(0);
        }

        // Recover the signer address
        return ecrecover(messageHash, v, r, s);
    }
 

 function fn_RequestFlashLoan(
        address asset,
        uint256 amount,
        bytes memory routeData
    ) external {
        address receiverAddress = address(this);
        uint16 referralCode = 0;
    

        POOL.flashLoanSimple(
            receiverAddress,
            asset,
            amount,
            routeData,
            referralCode
        );
    }

   function executeOperation(
         address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
       
      (SwapDescription memory desc, bytes memory signature, bytes memory routeData) = abi.decode(
        params, 
        (SwapDescription, bytes, bytes)
    );

      // Calculate the `dataHash` using the decoded `desc`
    bytes32 dataHash = keccak256(
        abi.encode(
            desc.srcToken,
            desc.dstToken,
            desc.srcReceiver,
            desc.dstReceiver,
            desc.amount,
            desc.minReturnAmount,
            desc.flags
        )
    );

    // Verify the signature //
    bytes4 magicValue = this.isValidSignature(dataHash, signature);
    uint256 swappedAmount; // Store the swapped amount for use in the next step
   
    if (asset != address(desc.srcToken)) {
    
    uint256 normalizedExpectedAmount = normalizeTo18(desc.amount, address(desc.srcToken));
    uint256 slippageBps = 10; // Example: 0.1% slippage
   uint256 minReturnAmount1 = (normalizedExpectedAmount * (10000 - slippageBps)) / 10000;

    address v3Factory = 0x1F98431c8aD98523631AE4a59f267346ea31F984; // 0x1F98431c8aD98523631AE4a59f267346ea31F984 Replace with Uniswap V3 Factory address 
     (address v3PoolAddress, uint24 feeTier) = getValidUniswapV3Pool(v3Factory, asset, address(desc.srcToken));
    // uint24 feeTier = 3000; // Default fee tier for Uniswap V3
 // address v3PoolAddress = IUniswapV3Factory(v3Factory).getPool(asset, address(desc.srcToken), feeTier);

   IUniswapV3Pool pool = IUniswapV3Pool(v3PoolAddress);
   uint128 poolLiquidity = pool.liquidity();
   (uint160 sqrtPriceX96, int24 tick, , , , , ) = pool.slot0();
 
    // Calculate price using sqrtPriceX96
    uint256 price = uint256(sqrtPriceX96) * uint256(sqrtPriceX96) / (2**192);
    Address dex = encodeDexForUniswapV3(v3PoolAddress);
     _setAllowance(IERC20(asset), address(genericRouter), amount);
    _setAllowance(IERC20(desc.srcToken), address(genericRouter), desc.amount);
     
 uint256 swappedAmount1 = GenericRouter(genericRouter).unoswapTo(
    Address.wrap(uint256(uint160(address(this)))), // Wrap address(this)
    Address.wrap(uint256(uint160(asset))),         // Wrap asset address
    amount,
    minReturnAmount1,
    dex // Wrap v3PoolAddress
   );
       // Ensure the swap meets the slippage-adjusted minimum
  require(swappedAmount1 >= minReturnAmount1, "Swap did not meet slippage-adjusted minimum");
    }

    swappedAmount = IERC20(desc.srcToken).balanceOf(address(this));
    uint256 amountDesc = swappedAmount;
    uint256 normalizedDescAmount = normalizeTo18(amountDesc, address(desc.srcToken));
    // Recalculate slippage-adjusted minimum return amount for the second swap
    uint256 slippageBpsS = 10; // 0.1% slippage tolerance
    uint256 minReturnAmount2 = (normalizedDescAmount * (10000 - slippageBpsS)) / 10000;

    // Set allowances for the second swap
    _setAllowance(IERC20(desc.srcToken), address(genericRouter), normalizedDescAmount);
 
    GenericRouter.SwapDescription memory routerDesc = GenericRouter.SwapDescription({
    srcToken: desc.srcToken,
    dstToken: desc.dstToken,
    srcReceiver: payable(address(IAggregationExecutor(0xE37e799D5077682FA0a244D46E5649F71457BD09))),
    dstReceiver: payable(address(this)),
    amount: normalizedDescAmount,
    minReturnAmount: minReturnAmount2,
    flags: desc.flags
   });

       // Call the swap function
        (uint256 returnAmount, uint256 spentAmount ) = GenericRouter(genericRouter).swap(
                IAggregationExecutor(0xE37e799D5077682FA0a244D46E5649F71457BD09),
                routerDesc,
                routeData
        );
   
    // Ensure the return amount meets the minimum required
    uint256 scaledMinReturnAmount = (desc.minReturnAmount * spentAmount) / desc.amount;
    require(returnAmount >= scaledMinReturnAmount, "Insufficient return amount");

        // Repay the flash loan with premiums
        uint256 totalOwed = amount + premium;
        IERC20(asset).approve(address(POOL), totalOwed);

        uint256 profit = returnAmount > totalOwed ? returnAmount - totalOwed : 0;
        emit FlashLoanExecuted(profit);
        return true;
    }


 // Ensure accurate allowance setting
    function _setAllowance(IERC20 token, address spender, uint256 amount) internal {
        uint256 currentAllowance = token.allowance(address(this), spender);
        if (currentAllowance < amount) {
            if (currentAllowance > 0) {
                token.approve(spender, 0);
            }
            token.approve(spender, amount);
        }
    }

   function getTokenDecimals(address token) internal view returns (uint8) {
    if (token == 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE) {
        return 18; // Native token (e.g., ETH/MATIC) assumed to have 18 decimals
    }
    try IERC20Metadata(token).decimals() returns (uint8 decimals) {
        return decimals; // ERC-20 token decimals
    } catch {
        return 18; // Default to 18 decimals if `decimals()` is not implemented
    }
 }


 function normalizeTo18(uint256 amount, address token) internal view returns (uint256) {
    if (token == 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE) {
        return amount; // Native tokens are already assumed to have 18 decimals
    }

    uint8 tokenDecimals = getTokenDecimals(token);

    if (tokenDecimals < 18) {
        return amount * (10 ** (18 - tokenDecimals)); // Scale up
    } else if (tokenDecimals > 18) {
        return amount / (10 ** (tokenDecimals - 18)); // Scale down
    }
    return amount; // Already scaled to 18 decimals
 }

function getValidUniswapV3Pool(
    address factory, // Uniswap V3 Factory address
    address tokenA, 
    address tokenB
) internal view returns (address poolAddress, uint24 feeTier) {
    uint24[3] memory feeTiers = [uint24(500), uint24(3000), uint24(10000)]; // Supported fee tiers
    for (uint256 i = 0; i < feeTiers.length; i++) {
        poolAddress = IUniswapV3Factory(factory).getPool(tokenA, tokenB, feeTiers[i]);
        if (poolAddress != address(0)) {
            feeTier = feeTiers[i];
            return (poolAddress, feeTier);
        }
    }
    revert("No valid Uniswap V3 Pool for the given pair");
}

function encodeDexForUniswapV3(address poolAddress) internal pure returns (Address) {
    uint256 protocolIdentifier = uint256(ProtocolLib.Protocol.UniswapV3); // Protocol identifier for UniswapV3
    uint256 encodedDex = uint256(uint160(poolAddress)) | (protocolIdentifier << _PROTOCOL_OFFSET);
    return Address.wrap(encodedDex);
}

 
    function withdrawProfits() external onlyOwner {
        uint256 contractBalance = usdtToken.balanceOf(address(this));
        require(contractBalance > 0, "No USDT profits to withdraw");
        usdtToken.safeTransfer(owner(), contractBalance);
    }


 function withdrawTokens(address token, uint256 amount) internal {
        IERC20(token).transfer(owner(), amount);
 }

 receive() external payable {}

 }
