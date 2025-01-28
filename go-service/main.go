package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"container/heap"
	"math/big"
	"sync"
	"io/ioutil"
	"net/http"
	"os"
        "os/signal"
        "syscall"
        "bytes"
	"strings"
	"time"
        "strconv"
	"math"
        "runtime"
	"errors"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
         "github.com/redis/go-redis/v9"
        "github.com/ethereum/go-ethereum/rpc"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/gorilla/websocket"
        "github.com/patrickmn/go-cache"
	"github.com/ethereum/go-ethereum/crypto"
)

type RetryFunction func() (interface{}, error)

type WebSocketSession struct {
	SessionID string
	Client    *WebSocketClient
	State     map[string]interface{} // Store client-specific state
}

var (
	wsSessions     = make(map[string]*WebSocketSession)
	sessionMutex   sync.Mutex
)

type ArbitrageOpportunity struct {
	TxHash   string  `json:"txHash"`
	Profit   string  `json:"profit"`
	SrcToken string  `json:"srcToken"`
	DstToken string  `json:"dstToken"`
	AmountIn string  `json:"amountIn"`
}

// HealthCheckResponse represents the JSON structure of the health check response
type HealthCheckResponse struct {
	Status      string `json:"status"`
	Uptime      string `json:"uptime"`
	GoVersion   string `json:"goVersion"`
	NumGoroutine int   `json:"numGoroutine"`
	MemoryUsage struct {
		Alloc      uint64 `json:"alloc"`      // Allocated memory in bytes
		TotalAlloc uint64 `json:"totalAlloc"` // Total allocated memory in bytes
		Sys        uint64 `json:"sys"`        // System memory in bytes
	} `json:"memoryUsage"`
	StartTime string `json:"startTime"`
}

var startTime time.Time
var redisClient *redis.Client

var (
	uniswapABI    abi.ABI
	sushiSwapABI  abi.ABI
)
var marketDataQueue = make(chan MarketData, 500) // Buffered channel to queue update
var apiRateLimiter = NewRateLimiter(5, time.Second) // Allow 5 API calls per second //"go-redis"
var wg sync.WaitGroup
var abis = map[string]abi.ABI{}
var rateLimiter = NewRateLimiter(5, time.Second)
const oneInchPriceAPI = "https://api.1inch.dev/price/v1.1/42161"

const UniswapV3RouterABI = `[
  {"inputs":[{"internalType":"address","name":"_factory","type":"address"},{"internalType":"address","name":"_WETH9","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},
  {"inputs":[{"components":[{"internalType":"bytes","name":"path","type":"bytes"},{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOutMinimum","type":"uint256"}],"internalType":"struct ISwapRouter.ExactInputParams","name":"params","type":"tuple"}],"name":"exactInput","outputs":[{"internalType":"uint256","name":"amountOut","type":"uint256"}],"stateMutability":"payable","type":"function"},
  {"inputs":[{"components":[{"internalType":"address","name":"tokenIn","type":"address"},{"internalType":"address","name":"tokenOut","type":"address"},{"internalType":"uint24","name":"fee","type":"uint24"},{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOutMinimum","type":"uint256"},{"internalType":"uint160","name":"sqrtPriceLimitX96","type":"uint160"}],"internalType":"struct ISwapRouter.ExactInputSingleParams","name":"params","type":"tuple"}],"name":"exactInputSingle","outputs":[{"internalType":"uint256","name":"amountOut","type":"uint256"}],"stateMutability":"payable","type":"function"}
]`

const SushiSwapRouterABI = `[
  {"inputs":[{"internalType":"address","name":"tokenA","type":"address"},{"internalType":"address","name":"tokenB","type":"address"},{"internalType":"uint256","name":"amountADesired","type":"uint256"},{"internalType":"uint256","name":"amountBDesired","type":"uint256"},{"internalType":"uint256","name":"amountAMin","type":"uint256"},{"internalType":"uint256","name":"amountBMin","type":"uint256"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"}],"name":"addLiquidity","outputs":[{"internalType":"uint256","name":"amountA","type":"uint256"},{"internalType":"uint256","name":"amountB","type":"uint256"},{"internalType":"uint256","name":"liquidity","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOutMin","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"}],"name":"swapExactTokensForTokens","outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],"stateMutability":"nonpayable","type":"function"}
]`

type InputData struct {
	TokenPairs   []string `json:"tokenPairs"`
	ChainID      int64      `json:"chainId"`
	StartToken   string   `json:"startToken"`
	StartAmount  float64  `json:"startAmount"`
	MaxHops      int      `json:"maxHops"`
	ProfitMargin float64  `json:"profitMargin"`
}

type OutputData struct {
	ProfitableRoutes []string  `json:"profitableRoutes"`
	ProfitValues     []float64 `json:"profitValues"`
}

type Transaction struct {
	From     string   `json:"from"`
	To       string   `json:"to"`
	Data     string   `json:"data"`
	Value    *big.Int `json:"value"`
	Gas      uint64   `json:"gas"`
	GasPrice *big.Int `json:"gasPrice"`
}

type PermitDetails struct {
	Nonce       uint64 `json:"nonce"`
	Signature   string `json:"signature"`
	PermitBatch string `json:"permitBatch"`
}

type WeightedGraph struct {
    AdjacencyList map[string]map[string]EdgeWeight // Nested maps for graph edges
    TokenPrices   map[string]*big.Float           // Token prices mapped by token address
}

// type MarketData struct {
//         ChainID         int64                      `json:"chainId"`
//         StartToken      string                     `json:"startToken"`
//         StartAmount     string                     `json:"startAmount"` // Use string for large numbers
//         MaxHops         int                        `json:"maxHops"`
//         ProfitThreshold string                     `json:"profitThreshold"` // Use string for large numbers
//         TokenPrices     map[string]float64        `json:"tokenPrices"`
//         Liquidity       []LiquidityData           `json:"liquidity"`
//         GasPrice        *big.Float                 `json:"gasPrice"` // Ensure GasPrice is added
//         HistoricalProfits []float64           `json:"historicalProfits"` // Add this field
//     }

type MarketData struct {
    ChainID          int64                      `json:"chainId"`
    StartToken       string                     `json:"startToken"`
    StartAmount      *BigInt                    `json:"startAmount"` // Custom type for large numbers
    MaxHops          int                        `json:"maxHops"`
    ProfitThreshold  *big.Float                    `json:"profitThreshold"` // Custom type for large numbers
    TokenPrices      map[string]float64         `json:"tokenPrices"`
    Liquidity        []LiquidityData            `json:"liquidity"`
    GasPrice         *big.Float                 `json:"gasPrice"` // Ensure GasPrice is added
    HistoricalProfits []float64                 `json:"historicalProfits"` // Add this field
}


type EdgeWeight struct {
	Weight            *big.Float   // Weight of the edge (e.g., price or inverse liquidity)
	Liquidity         *big.Float   // Liquidity available for the edge
	HistoricalLiquidity []float64  // Historical liquidity data for stability scoring
}

//type BigInt big.Int

type LiquidityEntry struct {
    BaseToken      string
    TargetToken    string
    DstAmount      *big.Float
    NormalizedPrice float64
    Gas            int64 // Add Gas field
}


type Receipt struct {
	TransactionHash string `json:"transactionHash"`
}

type WebSocketClient struct {
	Conn          *websocket.Conn
	RateLimiter   *RateLimiter
	Disconnected  chan bool
	Context       context.Context
	CancelFunc    context.CancelFunc
}

// RateLimiter controls the rate of messages for a client.
type RateLimiter struct {
	mu       sync.Mutex
	capacity int           // Maximum tokens allowed
	tokens   int           // Current token count
	interval time.Duration // Time interval for refilling tokens
	stop     chan bool     // Stop channel for refill loop
}

// WebSocket connection manager
//var wsClients = make(map[*websocket.Conn]bool)
// Global shared Ethereum client
var sharedClient *ethclient.Client
var clientOnce sync.Once
// Global WebSocket Broadcast Channel
var wsBroadcast = make(chan ArbitrageOpportunity)
// BroadcastChannel for messages
// Hardcoded stable token addresses
var hardcodedStableTokens = []Token{
	{"0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "USDT", 6, "Tether USD"},
	{"0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "USDC", 6, "USD Coin"},
	{"0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", "DAI", 18, "Dai Stablecoin"},
	{"0x82af49447d8a07e3bd95bd0d56f35241523fbab1", "WETH", 18, "Wrapped Ether"},
	{"0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", "WBTC", 8, "Wrapped Bitcoin"},
}

// WebSocket clients map and lock
var (
        broadcastChan = make(chan []byte)
	wsClients = make(map[*WebSocketClient]bool)
	clientsMutex sync.Mutex
	upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}
)

// Global cache instance for stable token data
// Cache Initialization
var stableTokenCache = cache.New(5*time.Minute, 10*time.Minute)
var tokenPriceCache = &TokenPriceCache{
    cache: make(map[string]interface{}),
}
var orderBookCache = cache.New(5*time.Minute, 10*time.Minute)

var (
	hardcodedStableAddresses = []string{
		"0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT
		"0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
		"0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", // DAI
		"0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
		"0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", // WBTC
	}

	// Cache duration in seconds
	tokenPriceCacheDuration = 600 // 10 minutes
)

// Token represents the structure of a token
type Token struct {
	Address  string `json:"address"`
	Symbol   string `json:"symbol"`
	Decimals int    `json:"decimals"`
	Name     string `json:"name"`
}

// Cache structure for storing stable token list
type StableTokenCache struct {
	mu    sync.Mutex
	cache map[string]CacheEntry
}


// Cache structure for token prices
type TokenPriceCache struct {
    mu    sync.Mutex
    cache map[string]interface{}
}

// Node represents a node in the priority queue
type Node struct {
	Token    string
	Priority float64
	Index    int
}

// PriorityQueue implements a priority queue for Dijkstra's algorithm
type PriorityQueue []*Node
const (
    CAPITAL1                = 100_000_000_000 // $100,000 USDC in base units (10^6)
    MINIMUM_PROFIT_THRESHOLD1 = 500_000       // $500 USDC in base units (10^6)
    DefaultGasEstimate1       = 800_000       // Default gas estimate per hop
)

// OrderBook represents the liquidity and other details of a trading pair
type OrderBook struct {
	Liquidity *big.Float
}

// Cache structure for storing order book data
type OrderBookCache struct {
	mu    sync.Mutex
	cache map[string]CacheEntry
}

type CacheEntry struct {
   Timestamp time.Time
    Data      interface{}
}

// Cache duration in seconds
//const cacheDuration = 600 // 10 minutes
const DefaultGasEstimate = 800000
const DefaultRetries = 3

// Cache structure to store quotes
type QuoteCache struct {
	mu    sync.Mutex
	cache map[string]interface{}
}

var quoteCache = QuoteCache{
	cache: make(map[string]interface{}),
}

type RateLimitTracker struct {
	Used      int
	Remaining int
	ResetTime time.Time
}

type Payload struct {
    TokenPrices     map[string]float64
    ProfitThreshold float64
    Liquidity       []LiquidityData
}

type BigInt struct {
    value *big.Int
}

type LiquidityData struct {
    BaseToken   string    `json:"baseToken"`
    TargetToken string    `json:"targetToken"`
    DstAmount   *big.Float `json:"dstAmount"` // Use big.Float for USD values
    Gas         int64     `json:"gas"`
    Decimals    int       `json:"decimals"`  // Optional: Token-specific decimals
    Paths          [][][]PathSegment  `json:"paths"`
    NormalizedPrice *big.Float // Add this field for compatibility
}

type Liquidity struct {
    // Define fields based on your use case
    FromToken  string
    ToToken    string
    Amount     *big.Int
    Protocol   string
}


type PathSegment struct {
    Name             string
    Part             float64
    FromTokenAddress string
    ToTokenAddress   string
}


var apiRateLimits = make(map[string]*RateLimitTracker)


type TokenPair struct {
    SrcToken string `json:"srcToken"`
    DstToken string `json:"dstToken"`
    Weight   float64 // Added Weight field
}

type Route struct {
	ChainID      int64      `json:"chainId"`
	StartToken   string     `json:"startToken"`
	StartAmount  *big.Int   `json:"startAmount"`
	Hops         int        `json:"hops"`
	Profit       *big.Int   `json:"profit"`
	Path         []string   `json:"path"` // Sequence of tokens in the route
}

type StableToken struct {
	Address string `json:"address"`
}

type Graph struct {
	AdjacencyList map[string]map[string]*big.Float
}

// Cache for storing gas price
var (
	gasPriceCache = struct {
		sync.RWMutex
		price     *big.Int
		timestamp time.Time
	}{}
	cacheDuration = 1 * time.Minute // Cache duration
)

// Constants
var (
	CAPITAL                 *big.Int
	MINIMUM_PROFIT_THRESHOLD = big.NewInt(500000000000000000) // $500 in USDC
	FLASHLOAN_FEE_RATE       = big.NewFloat(0.0009)          // 0.09% fee
)


// TokenPrice represents token data including price and liquidity
type TokenPrice struct {
	Price     *big.Float
	Liquidity *big.Float
        Decimals int        // Number of decimals for the token
}

func (pq PriorityQueue) Len() int {
	return len(pq)
}

func (pq PriorityQueue) Less(i, j int) bool {
	return pq[i].Priority < pq[j].Priority
}

func (pq PriorityQueue) Swap(i, j int) {
	pq[i], pq[j] = pq[j], pq[i]
	pq[i].Index = i
	pq[j].Index = j
}

func loadABI(abiString string) abi.ABI {
	parsedABI, err := abi.JSON(strings.NewReader(abiString))
	if err != nil {
		log.Fatalf("Failed to parse ABI: %v", err)
	}
	return parsedABI
}

// isTokenHardcoded checks if a given token address is in the hardcoded list
func isTokenHardcoded(tokenAddress string) bool {
	for _, addr := range hardcodedStableAddresses {
		if strings.EqualFold(addr, tokenAddress) { // Case-insensitive comparison
			return true
		}
	}
	return false
}


func fetchWithRetry(url string, headers map[string]string) ([]byte, error) {
      // Declare result and err
    var result interface{}
    var err error

	operation := func() (interface{}, error) {
		req, err := http.NewRequest("GET", url, nil)
		if err != nil {
			return nil, err
		}

		for key, value := range headers {
			req.Header.Set(key, value)
		}

		client := &http.Client{}
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()

		if resp.StatusCode == 429 {
			return nil, fmt.Errorf("rate limit exceeded: %d", resp.StatusCode)
		}

		if resp.StatusCode != http.StatusOK {
			body, _ := ioutil.ReadAll(resp.Body)
			return nil, fmt.Errorf("unexpected status code %d: %s", resp.StatusCode, string(body))
		}

		return ioutil.ReadAll(resp.Body)
	}

	// Call Retry with the operation
    result, err = Retry(operation, 3, 1*time.Second)
    if err != nil {
        return nil, err
    }

    // Type assert the result to []byte
    if byteResult, ok := result.([]byte); ok {
        return byteResult, nil
    }

    return nil, fmt.Errorf("unexpected result type from Retry function")
}

func fetchWithRateLimit(url string, headers, params map[string]string) ([]byte, error) {
	client := &http.Client{}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %v", err)
	}

	// Add headers
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	// Add query parameters
	query := req.URL.Query()
	for key, value := range params {
		query.Add(key, value)
	}
	req.URL.RawQuery = query.Encode()

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, fmt.Errorf("rate limit exceeded")
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := ioutil.ReadAll(resp.Body)
		return nil, fmt.Errorf("unexpected status code: %d, body: %s", resp.StatusCode, string(body))
	}

	return ioutil.ReadAll(resp.Body)
}


// Push adds a node to the priority queue
func (pq *PriorityQueue) Push(x interface{}) {
	n := x.(*Node)         // Cast the interface{} to a *Node.
	n.Index = len(*pq)     // Set the index of the new node.
	*pq = append(*pq, n)   // Append the node to the queue.
}

func (pq *PriorityQueue) Pop() interface{} {
	old := *pq             // Dereference the pointer to the queue.
	n := len(old)          // Get the current length of the queue.
	node := old[n-1]       // Get the last node in the queue.
	old[n-1] = nil         // Avoid memory leak by removing the reference.
	node.Index = -1        // Set the index of the removed node to -1.
	*pq = old[:n-1]        // Resize the queue to exclude the removed node.
	return node            // Return the removed node.
}

func (pq *PriorityQueue) Update(node *Node, priority float64) {
	node.Priority = priority // Update the priority of the node.
	heap.Fix(pq, node.Index) // Reorder the heap to maintain the heap property.
}

// Adjust updates the capacity and refill interval dynamically.
func (rl *RateLimiter) Adjust(newCapacity int, newInterval time.Duration) {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	rl.capacity = newCapacity
	rl.interval = newInterval
	rl.tokens = min(rl.tokens, rl.capacity) // Ensure tokens do not exceed capacity
}

// UnmarshalJSON implements JSON unmarshaling for BigInt
func (b *BigInt) UnmarshalJSON(data []byte) error {
	str := string(data)
	str = strings.Trim(str, `"`) // Remove quotes if present
	val := new(big.Int)
	if _, ok := val.SetString(str, 10); !ok {
		return fmt.Errorf("invalid BigInt format: %s", str)
	}
	b.value = val
	return nil
}

// MarshalJSON implements JSON marshaling for BigInt
func (b *BigInt) MarshalJSON() ([]byte, error) {
	if b.value == nil {
		return []byte(`"0"`), nil // Default to "0" if nil
	}
	return []byte(fmt.Sprintf(`"%s"`, b.value.String())), nil
}


// func (b *BigInt) UnmarshalJSON(data []byte) error {
//     // Remove quotes from JSON string
//     var str string
//     if err := json.Unmarshal(data, &str); err != nil {
//         return fmt.Errorf("failed to unmarshal big.Int as string: %w", err)
//     }

//     // Parse string into big.Int
//     temp := new(big.Int)
//     if _, ok := temp.SetString(str, 10); !ok {
//         return fmt.Errorf("invalid big.Int value: %s", str)
//     }

//     *b = BigInt(*temp)
//     return nil
// }

// Convert back to `*big.Int` if needed
// func (b *BigInt) ToBigInt() *big.Int {
//     return (*big.Int)(b)
// }

// ToBigInt converts a *BigInt to a *big.Int
func (b *BigInt) ToBigInt() *big.Int {
	if b == nil || b.value == nil {
		return big.NewInt(0) // Return a zero value if BigInt or its value is nil
	}
	return b.value
}

// NewRateLimiter initializes a new rate limiter with 1 message per second.
func NewRateLimiter(capacity int, interval time.Duration) *RateLimiter {
	rl := &RateLimiter{
		capacity: capacity,
		tokens:   capacity,
		interval: interval,
		stop:     make(chan bool),
	}
	go rl.refill()
	return rl
}

func logAPILimits() {
	for api, tracker := range apiRateLimits {
		log.Printf("API: %s, Used: %d, Remaining: %d, Resets at: %v", api, tracker.Used, tracker.Remaining, tracker.ResetTime)
	}
}

// NewDynamicRateLimiter creates a rate limiter with dynamic capacity and refill interval.
func NewDynamicRateLimiter(capacity int, refillInterval time.Duration) *RateLimiter {
	rl := &RateLimiter{
		capacity: capacity,
		tokens:   capacity,
		interval: refillInterval,
		stop:     make(chan bool),
	}

	go rl.refill()
	return rl
}


// Allow checks if the request can proceed, decrementing tokens if allowed.
func (rl *RateLimiter) Allow() bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	if rl.tokens > 0 {
		rl.tokens--
		return true
	}
	return false
}

// refill adds tokens periodically up to the current capacity.
func (rl *RateLimiter) refill() {
	ticker := time.NewTicker(rl.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			rl.mu.Lock()
			if rl.tokens < rl.capacity {
				rl.tokens++
			}
			rl.mu.Unlock()
		case <-rl.stop:
			return
		}
	}
}

// Stop terminates the refill goroutine.
func (rl *RateLimiter) Stop() {
	close(rl.stop)
}

// Retry retries a function with exponential backoff.
func Retry(operation RetryFunction, maxRetries int, initialBackoff time.Duration) (interface{}, error) {
    backoff := initialBackoff
    var result interface{}
    var err error

    for attempt := 1; attempt <= maxRetries; attempt++ {
        result, err = operation()
        if err == nil {
            return result, nil
        }

        log.Printf("Retry attempt %d/%d failed: %v", attempt, maxRetries, err)
        time.Sleep(backoff)
        backoff *= 2
    }

    return nil, fmt.Errorf("operation failed after %d retries: %w", maxRetries, err)
}

// getStableTokenList fetches the stable token list or falls back to hardcoded tokens
func getStableTokenList(chainID int64) ([]Token, error) {
	cacheKey := fmt.Sprintf("stableTokens:%d", chainID)

	// Check cache for existing data
	if cachedData, exists := getFromStableTokenCache(cacheKey); exists {
		log.Println("Returning cached stable token list.")
		return cachedData.([]Token), nil
	}

	// Build API request
	url := fmt.Sprintf("https://api.1inch.dev/v4.0/%d/custom", chainID)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %v", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", getEnv("ONEINCH_API_KEY", "")))

	// Pass addresses as query parameter
	query := req.URL.Query()
	addresses := []string{}
	for _, token := range hardcodedStableTokens {
		addresses = append(addresses, strings.ToLower(token.Address))
	}
	query.Set("addresses", strings.Join(addresses, ","))
	req.URL.RawQuery = query.Encode()

	// Send the request
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("Error fetching stable token list: %v", err)
		return fallbackStableTokens(), nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("Received non-200 status: %d", resp.StatusCode)
		return fallbackStableTokens(), nil
	}

	// Parse response
	var apiResponse struct {
		Tokens map[string]struct {
			Symbol   string `json:"symbol"`
			Decimals int    `json:"decimals"`
			Name     string `json:"name"`
		} `json:"tokens"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&apiResponse); err != nil {
		log.Printf("Error decoding response: %v", err)
		return fallbackStableTokens(), nil
	}

	// Normalize response data
	var stableTokens []Token
	for address, tokenData := range apiResponse.Tokens {
		stableTokens = append(stableTokens, Token{
			Address:  address,
			Symbol:   tokenData.Symbol,
			Decimals: tokenData.Decimals,
			Name:     tokenData.Name,
		})
	}

	// Cache the response and return
	setToStableTokenCache(cacheKey, stableTokens)
	log.Printf("Fetched stable token list: %+v", stableTokens)
	return stableTokens, nil
}

// Fallback to hardcoded tokens
func fallbackStableTokens() []Token {
	log.Println("Falling back to hardcoded stable tokens.")
	return hardcodedStableTokens
}

// Helper functions for caching
func getFromStableTokenCache(key string) (interface{}, bool) {
    return stableTokenCache.Get(key)
}

// Token Price Cache Functions
func setToTokenPriceCache(cacheKey string, data interface{}) {
    tokenPriceCache.mu.Lock()
    defer tokenPriceCache.mu.Unlock()
    tokenPriceCache.cache[cacheKey] = data
    go func() {
        time.Sleep(time.Duration(tokenPriceCacheDuration) * time.Second)
        tokenPriceCache.mu.Lock()
        delete(tokenPriceCache.cache, cacheKey)
        tokenPriceCache.mu.Unlock()
    }()
}

func getFromTokenPriceCache(cacheKey string) (interface{}, bool) {
    tokenPriceCache.mu.Lock()
    defer tokenPriceCache.mu.Unlock()
    cachedData, exists := tokenPriceCache.cache[cacheKey]
    return cachedData, exists
}


// Callback for cache expiration (optional but useful for debugging)
func setupCacheExpirationLogging() {
	stableTokenCache.OnEvicted(func(key string, value interface{}) {
		log.Printf("Cache entry expired for key: %s", key)
	})
}


// Initialize the cache with expiration logging
func init() {
        CAPITAL = new(big.Int)
	_, ok := CAPITAL.SetString("100000000000000000000000", 10)
	if !ok {
		log.Fatal("Failed to set value for CAPITAL")
	}
        startTime = time.Now()
	setupCacheExpirationLogging()
        uniswapABI = loadABI(UniswapV3RouterABI)
	sushiSwapABI = loadABI(SushiSwapRouterABI)
        // Populate the map
       abis = map[string]abi.ABI{
        "uniswap":   uniswapABI,
        "sushiswap": sushiSwapABI,
       }
     log.Println("Uniswap and SushiSwap ABIs successfully loaded.")
}

func setToStableTokenCache(key string, value interface{}) {
    stableTokenCache.Set(key, value, cache.DefaultExpiration)
}

// healthHandler handles the /health endpoint
func healthHandler(w http.ResponseWriter, r *http.Request) {
	// Calculate uptime
	uptime := time.Since(startTime).String()

	// Gather memory stats
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)

	// Create the response object
	response := HealthCheckResponse{
		Status:      "ok",
		Uptime:      uptime,
		GoVersion:   runtime.Version(),
		NumGoroutine: runtime.NumGoroutine(),
		StartTime:   startTime.Format(time.RFC3339),
	}
	response.MemoryUsage.Alloc = memStats.Alloc
	response.MemoryUsage.TotalAlloc = memStats.TotalAlloc
	response.MemoryUsage.Sys = memStats.Sys

	// Set response headers and write JSON response
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(response)
}


func ComputeOptimalRoute(graph *WeightedGraph, startToken, endToken string, maxHops int) ([]string, *big.Float, error) {
    startToken = strings.ToLower(startToken) // Normalize input
    endToken = strings.ToLower(endToken)    // Normalize input
    log.Printf("Starting optimal route computation from %s to %s with a maximum of %d hops", startToken, endToken, maxHops)

    // Validate start and end tokens in the graph
    if _, exists := graph.AdjacencyList[startToken]; !exists {
        log.Printf("Start token %s not found in graph", startToken)
        return nil, nil, fmt.Errorf("start token %s not in graph", startToken)
    }
    if _, exists := graph.AdjacencyList[endToken]; !exists {
        log.Printf("End token %s not found in graph", endToken)
        return nil, nil, fmt.Errorf("end token %s not in graph", endToken)
    }

    // Initialize distances, previous map, hop count, and visited map
    distances := make(map[string]*big.Float)
    previous := make(map[string]string)
    hops := make(map[string]int)
    visited := make(map[string]bool)

    for token := range graph.AdjacencyList {
        distances[token] = big.NewFloat(math.Inf(1)) // Set all distances to infinity
        hops[token] = 0                             // Initialize hop count to 0
    }
    distances[startToken] = big.NewFloat(0) // Distance to the startToken is 0

    // Priority queue for Dijkstra/A* algorithm
    pq := make(PriorityQueue, 0)
    heap.Init(&pq)
    heap.Push(&pq, &Node{Token: startToken, Priority: 0})

    for pq.Len() > 0 {
        current := heap.Pop(&pq).(*Node)
        currentToken := current.Token
        currentPriority := current.Priority

        // Skip already visited nodes
        if visited[currentToken] {
            log.Printf("Node %s already visited. Skipping...", currentToken)
            continue
        }
        visited[currentToken] = true
        log.Printf("Processing node %s with priority %f", currentToken, currentPriority)

        // Check if the endToken is reached
        if currentToken == endToken {
            log.Println("Destination reached. Reconstructing path...")
            path := reconstructPath(previous, startToken, endToken)
            log.Printf("Path found: %v | Total distance: %s", path, distances[endToken].String())
            return path, distances[endToken], nil
        }

        // Process all neighbors of the current token
        if len(graph.AdjacencyList[currentToken]) == 0 {
            log.Printf("Orphan token %s has no neighbors. Skipping...", currentToken)
            continue
        }

        for neighbor, edge := range graph.AdjacencyList[currentToken] {
            log.Printf("Evaluating neighbor %s from node %s with edge weight %s", neighbor, currentToken, edge.Weight.String())

            // Skip visited neighbors or low-liquidity edges
            if visited[neighbor] {
                log.Printf("Neighbor %s skipped: already visited", neighbor)
                continue
            }
            if edge.Liquidity.Cmp(big.NewFloat(1e-6)) < 0 {
                log.Printf("Neighbor %s skipped: insufficient liquidity", neighbor)
                continue
            }

            // Check hop limit
            if hops[currentToken]+1 > maxHops {
                log.Printf("Neighbor %s skipped: exceeds max hops (%d)", neighbor, maxHops)
                continue
            }

            // Adjust weight with historical stability
            stabilityScore := calculateStabilityScore(edge.HistoricalLiquidity)
            adjustedWeight := new(big.Float).Quo(edge.Weight, big.NewFloat(stabilityScore))

            // Calculate tentative distance
            tentativeDistance := new(big.Float).Add(distances[currentToken], adjustedWeight)
            if tentativeDistance.Cmp(distances[neighbor]) < 0 {
                distances[neighbor] = tentativeDistance
                previous[neighbor] = currentToken
                hops[neighbor] = hops[currentToken] + 1 // Increment hop count
                log.Printf("Relaxing edge to neighbor %s. Updated distance: %s, Hops: %d", neighbor, tentativeDistance.String(), hops[neighbor])

                // Push the neighbor into the priority queue
                priorityFloat, _ := tentativeDistance.Float64()
                heap.Push(&pq, &Node{Token: neighbor, Priority: priorityFloat})
                log.Printf("Neighbor %s pushed to the queue with priority %f", neighbor, priorityFloat)
            } else {
                log.Printf("No relaxation needed for neighbor %s.", neighbor)
            }
        }
    }

    // If no path was found
    log.Printf("No path found from %s to %s within %d hops", startToken, endToken, maxHops)
    return nil, nil, fmt.Errorf("no path found from %s to %s within %d hops", startToken, endToken, maxHops)
}

// Helper function to calculate stability score based on historical liquidity
func calculateStabilityScore(historicalLiquidity []float64) float64 {
    if len(historicalLiquidity) == 0 {
        return 1.0 // Default stability score
    }
    sum := 0.0
    for _, value := range historicalLiquidity {
        sum += value
    }
    return sum / float64(len(historicalLiquidity))
}

// Helper function to reconstruct the path from startToken to endToken
func reconstructPath(previous map[string]string, startToken, endToken string) []string {
    path := []string{}
    for token := endToken; token != ""; token = previous[token] {
        path = append([]string{token}, path...)
    }
    return path
}

func calculateTotalGasCost(gasPrice *big.Int, gasEstimate int64) *big.Int {
    // Step 1: Convert gasEstimate to *big.Int
    gasEstimateBig := big.NewInt(gasEstimate)

    // Step 2: Calculate total gas cost as gasPrice * gasEstimate
    totalGasCost := new(big.Int).Mul(gasPrice, gasEstimateBig)

    // Step 3: Log the computation for debugging
    log.Printf("Calculated total gas cost: %s (GasPrice: %s, GasEstimate: %d)",
        totalGasCost.String(), gasPrice.String(), gasEstimate)

    return totalGasCost
}

// Helper to convert *big.Float to *big.Int
func convertBigFloatToInt(input interface{}) *big.Int {
    gasPriceInt := new(big.Int)

    switch v := input.(type) {
    case *big.Float:
        v.Int(gasPriceInt) // Convert *big.Float to *big.Int
    case *big.Int:
        gasPriceInt.Set(v) // Directly assign *big.Int
    default:
        log.Fatalf("Unsupported type for conversion: %T", input)
    }

    return gasPriceInt
}


func normalizeTokenPrices(tokenPrices map[string]*big.Float) map[string]*big.Float {
    normalized := make(map[string]*big.Float)
    for token, price := range tokenPrices {
        normalized[strings.ToLower(token)] = price
    }
    return normalized
}

func convertPricesToTokenPriceMap(prices map[string]*big.Float) map[string]TokenPrice {
    tokenPriceMap := make(map[string]TokenPrice)
    for token, price := range prices {
        tokenPriceMap[token] = TokenPrice{Price: price}
    }
    return tokenPriceMap
}

func processMarketData(marketData MarketData) ([]LiquidityEntry, error) {
    var normalizedLiquidity []LiquidityEntry

    for _, entry := range marketData.Liquidity {
        // Convert *big.Float to float64
        dstAmountFloat64, _ := entry.DstAmount.Float64()

        normalizedLiquidity = append(normalizedLiquidity, LiquidityEntry{
            BaseToken:      entry.BaseToken,
            TargetToken:    entry.TargetToken,
            NormalizedPrice: dstAmountFloat64,
        })
    }

    return normalizedLiquidity, nil
}

func evaluateRouteProfit(
    startAmount *big.Int,
    path []string,
    tokenPrices map[string]*big.Float,
    gasPrice *big.Int,
    cost *big.Int,
    minProfitThreshold *big.Float,
) (bool, *big.Int) {
    gasFee := calculateTotalGasCost(gasPrice, DefaultGasEstimate)

    // Convert minProfitThreshold to *big.Int
    minProfitInt := new(big.Int)
    minProfitThreshold.Int(minProfitInt)

    // Convert startAmount and costs to USD
    gasPriceUSD := tokenPrices[path[0]]
    costUSD := convertToUSD(cost, gasPriceUSD, 18)
    gasFeeUSD := convertToUSD(gasFee, gasPriceUSD, 18)
    totalCostUSD := new(big.Float).Add(costUSD, gasFeeUSD)
    startAmountUSD := convertToUSD(startAmount, gasPriceUSD, 18)

    // Calculate profit
    profitUSD := new(big.Float).Sub(startAmountUSD, totalCostUSD)

    if profitUSD.Cmp(minProfitThreshold) > 0 {
        profitInt := new(big.Int)
        profitUSD.Int(profitInt)
        return true, profitInt
    }

    return false, nil
}

// Adjust for slippage
func adjustForSlippage(amountIn *big.Float, liquidity *big.Float) (*big.Float, error) {
    if liquidity == nil || liquidity.Cmp(big.NewFloat(0)) <= 0 {
        return nil, errors.New("invalid liquidity: must be greater than zero")
    }

    // Define the acceptable slippage percentage range (e.g., 0.01 = 1%)
    maxSlippageFactor := 0.01
    tolerance := 1e-6 // Small tolerance for convergence

    // Binary search boundaries
    low := big.NewFloat(0) // No slippage
    high := new(big.Float).Mul(amountIn, big.NewFloat(maxSlippageFactor)) // Maximum slippage
    adjustedAmount := new(big.Float).Set(amountIn)

    // Binary search loop
    for {
        mid := new(big.Float).Add(low, high).Quo(new(big.Float).Add(low, high), big.NewFloat(2)) // mid = (low + high) / 2
        testAmount := new(big.Float).Sub(amountIn, mid)                                          // adjusted amount = amountIn - mid

        // Simulate liquidity impact
        liquidityImpact := new(big.Float).Mul(liquidity, big.NewFloat(maxSlippageFactor))
        if testAmount.Cmp(liquidityImpact) <= 0 {
            high.Set(mid) // Adjust high boundary
        } else {
            low.Set(mid) // Adjust low boundary
        }

        // Update adjustedAmount
        adjustedAmount.Set(testAmount)

        // Break when the difference between high and low is within tolerance
        diff := new(big.Float).Sub(high, low)
        if diff.Cmp(big.NewFloat(tolerance)) <= 0 {
            break
        }
    }

    if adjustedAmount.Cmp(big.NewFloat(0)) <= 0 {
        return nil, errors.New("adjusted amount is negative or zero after slippage")
    }

    return adjustedAmount, nil
}

func optimizeGraphConstruction(graph *WeightedGraph) {
    for node, neighbors := range graph.AdjacencyList {
        for neighbor := range neighbors {
            if node == neighbor {
                log.Printf("Removing self-loop: %s -> %s", node, neighbor)
                delete(graph.AdjacencyList[node], neighbor)
            }
        }
    }
    log.Println("Graph optimization complete: Removed self-loops.")
}

func logEdgeDetails(src, dst string, weight float64, liquidity *big.Float) {
    log.Printf("Edge added: %s -> %s | Weight: %.6f | Liquidity: %s", src, dst, weight, liquidity.String())
}

func calculateDynamicProfitThreshold(gasCost *big.Int, gasPriceUSD *big.Float, decimals int) *big.Float {
    // Step 1: Convert gas cost to USD
    gasCostInUSD := convertToUSD(gasCost, gasPriceUSD, decimals)

    // Step 2: Define the base profit in USD
    baseProfitUSD := big.NewFloat(100) // Assume $100 base profit

    // Step 3: Calculate a gas buffer (2x the gas cost in USD)
    gasBuffer := new(big.Float).Mul(gasCostInUSD, big.NewFloat(2))

    // Step 4: Calculate the dynamic profit threshold
    dynamicThreshold := new(big.Float).Add(gasBuffer, baseProfitUSD)

    // Step 5: Log details for debugging and analysis
    log.Printf(
        "Calculated dynamic profit threshold: %s (GasCostUSD: %s, BaseProfitUSD: %s, GasBuffer: %s)",
        dynamicThreshold.Text('f', 8), gasCostInUSD.Text('f', 8), baseProfitUSD.Text('f', 8), gasBuffer.Text('f', 8),
    )

    return dynamicThreshold
}

func validateLiquidityEntries(liquidity []LiquidityData) []LiquidityData {
    validEntries := []LiquidityData{}
    zeroFloat := new(big.Float).SetInt(big.NewInt(0)) // Fix for comparison

    for _, entry := range liquidity {
        if entry.DstAmount.Cmp(zeroFloat) > 0 && entry.BaseToken != entry.TargetToken {
            validEntries = append(validEntries, entry)
        } else {
            log.Printf("Skipping invalid liquidity entry: BaseToken=%s, TargetToken=%s, DstAmount=%s",
                entry.BaseToken, entry.TargetToken, entry.DstAmount.String())
        }
    }
    return validEntries
}

// Set a value in the cache
func setToCache(key string, value interface{}) {
    quoteCache.mu.Lock()
    defer quoteCache.mu.Unlock()
    quoteCache.cache[key] = value
}

func getFromCache(key string) (interface{}, bool) {
    quoteCache.mu.Lock()
    defer quoteCache.mu.Unlock()
    value, exists := quoteCache.cache[key]
    return value, exists
}


// Get a value from the order book cache
func getFromOrderBookCache(key string) (interface{}, bool) {
    return orderBookCache.Get(key)
}

// Set a value in the order book cache
func setToOrderBookCache(key string, value interface{}) {
    orderBookCache.Set(key, value, cache.DefaultExpiration)
}

// Adjust for decimals
func adjustForDecimals(amount *big.Int, decimals int) *big.Int {
    factor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
    return new(big.Int).Mul(amount, factor)
}

// Helper function for exponential backoff retries
func fetchWithRetries(url string, headers map[string]string) ([]byte, error) {
    backoff := time.Second
    for i := 0; i < 3; i++ {
        req, err := http.NewRequest("GET", url, nil)
        if err != nil {
            return nil, fmt.Errorf("failed to create request: %v", err)
        }
        for key, value := range headers {
            req.Header.Set(key, value)
        }

        resp, err := http.DefaultClient.Do(req)
        if err != nil {
            log.Printf("Request failed: %v. Retrying...", err)
            time.Sleep(backoff)
            backoff *= 2
            continue
        }
        defer resp.Body.Close()

        if resp.StatusCode == http.StatusOK {
            return ioutil.ReadAll(resp.Body)
        }

        if resp.StatusCode == 429 {
            log.Println("Rate limit exceeded. Retrying...")
            time.Sleep(backoff)
            backoff *= 2
        } else {
            return nil, fmt.Errorf("unexpected status code: %d", resp.StatusCode)
        }
    }
    return nil, fmt.Errorf("failed to fetch data after retries")
}

// Fetch a single quote with caching and retries
func fetchQuote(chainID int64, srcToken, dstToken, amount string, complexityLevel, slippage int) (map[string]interface{}, error) {
    // Construct the cache key
    cacheKey := fmt.Sprintf("%s_%s_%s", srcToken, dstToken, amount)

    // Attempt to retrieve from cache
    cachedValue, exists := getFromCache(cacheKey)
    if exists {
        // Safely assert the cached value to the expected type
        if castValue, ok := cachedValue.(map[string]interface{}); ok {
            log.Println("Using cached quote:", castValue)
            return castValue, nil
        }
        log.Println("Cached value exists but is not of the expected type")
    } else {
        log.Println("Quote not found in cache")
    }

    // Construct the request URL
    url := fmt.Sprintf(
        "https://api.1inch.dev/swap/v6.0/%d/quote?src=%s&dst=%s&amount=%s&complexityLevel=%d",
        chainID, srcToken, dstToken, amount, complexityLevel,
    )

    // Add required headers
    headers := map[string]string{
        "Authorization": fmt.Sprintf("Bearer %s", getEnv("ONEINCH_API_KEY", "")),
    }

    // Fetch data with retries
    data, err := fetchWithRetries(url, headers)
    if err != nil {
        return nil, fmt.Errorf("failed to fetch quote for %s -> %s: %v", srcToken, dstToken, err)
    }

    // Parse the fetched data into a map
    var quote map[string]interface{}
    if err := json.Unmarshal(data, &quote); err != nil {
        return nil, fmt.Errorf("failed to parse quote response: %v", err)
    }

    // Cache the fetched quote for future use
    setToCache(cacheKey, quote)
    log.Println("Fetched and cached quote:", quote)

    return quote, nil
}

// Fetch multiple quotes concurrently with rate limiting
func fetchMultipleQuotes(chainID int64, tokenPairs [][2]string, amount string, complexityLevel, slippage int) ([]map[string]interface{}, error) {
    var wg sync.WaitGroup
    results := make([]map[string]interface{}, len(tokenPairs))
    errors := make([]error, len(tokenPairs))

    limit := make(chan struct{}, 5) // Limit concurrency to 5

    for i, pair := range tokenPairs {
        wg.Add(1)
        limit <- struct{}{}
        go func(i int, srcToken, dstToken string) {
            defer wg.Done()
            defer func() { <-limit }()
            quote, err := fetchQuote(chainID, srcToken, dstToken, amount, complexityLevel, slippage)
            if err != nil {
                errors[i] = err
                return
            }
            results[i] = quote
        }(i, pair[0], pair[1])
    }

    wg.Wait()

    var validResults []map[string]interface{}
    for i, res := range results {
        if errors[i] == nil {
            validResults = append(validResults, res)
        }
    }
    return validResults, nil
}

// Helper function to get environment variables with a default value
func getEnv(key, defaultValue string) string {
	value := strings.TrimSpace(key)
	if value == "" {
		return defaultValue
	}
	return value
}


// Helper to set cache with expiration
func cacheSetOrderBook(key string, value interface{}, duration time.Duration) {
    if orderBookCache == nil {
        log.Println("Order book cache is not initialized.")
        return
    }

    // Use go-cache's Set method
    orderBookCache.Set(key, value, duration)
    log.Printf("Order book cache set: key=%s, expiration=%v", key, duration)
}

// Helper to get value from cache
func cacheGetOrderBook(key string) (interface{}, bool) {
    if orderBookCache == nil {
        log.Println("Order book cache is not initialized.")
        return nil, false
    }

    // Use go-cache's Get method
    data, found := orderBookCache.Get(key)
    if found {
        log.Printf("Order book cache hit: key=%s, data=%v", key, data)
        return data, true
    }

    log.Printf("Order book cache miss: key=%s", key)
    return nil, false
}

// Fetch order book depth with retries and caching
func fetchOrderBookDepth(srcToken, dstToken string, chainID int64) ([]interface{}, error) {
	cacheKey := fmt.Sprintf("orderBook-%s-%s-%d", strings.ToLower(srcToken), strings.ToLower(dstToken), chainID)

	// Check the cache first
	if cachedData, exists := cacheGetOrderBook(cacheKey); exists {
		log.Printf("Using cached order book for %s -> %s", srcToken, dstToken)
		return cachedData.([]interface{}), nil
	}

	// Construct API request
	url := fmt.Sprintf("https://api.1inch.dev/orderbook/v4.0/%d/all", chainID)
	headers := map[string]string{
		"Content-Type":  "application/json",
		"Authorization": fmt.Sprintf("Bearer %s", getEnv("ONEINCH_API_KEY", "")),
	}
	params := map[string]string{
		"makerAsset": strings.ToLower(srcToken),
		"takerAsset": strings.ToLower(dstToken),
		"limit":      "50", // Max number of orders to fetch
	}

	const maxRetries = 3
	backoff := time.Second

	// Retry logic with exponential backoff and graceful fallback
	for attempt := 1; attempt <= maxRetries; attempt++ {
		log.Printf("Fetching order book for %s -> %s on chain %d (Attempt %d)...", srcToken, dstToken, chainID, attempt)

		// Use rate-limited fetch function
		responseData, err := fetchWithRateLimit(url, headers, params)
		if err != nil {
			// Handle rate limit errors with exponential backoff
			if strings.Contains(err.Error(), "rate limit") {
				log.Printf("Rate limit exceeded for %s -> %s. Retrying after %v...", srcToken, dstToken, backoff)
				time.Sleep(backoff)
				backoff *= 2
				continue
			}
			log.Printf("Error fetching order book for %s -> %s: %v", srcToken, dstToken, err)
			if attempt == maxRetries {
				return nil, fmt.Errorf("max retries reached for %s -> %s: %v", srcToken, dstToken, err)
			}
			continue
		}

		// Parse response
		var result struct {
			Orders []interface{} `json:"orders"`
		}
		if err := json.Unmarshal(responseData, &result); err != nil {
			log.Printf("Failed to parse order book response for %s -> %s: %v", srcToken, dstToken, err)
			return nil, fmt.Errorf("failed to parse order book response: %v", err)
		}

		if len(result.Orders) > 0 {
			// Cache the result for future use
			cacheSetOrderBook(cacheKey, result.Orders, cacheDuration*time.Second)
			log.Printf("Order book fetched and cached successfully for %s -> %s", srcToken, dstToken)
			return result.Orders, nil
		}

		log.Printf("No orders found for %s -> %s. Retrying if attempts remain.", srcToken, dstToken)
		time.Sleep(backoff) // Retry delay
		backoff *= 2
	}

	log.Printf("No orders found for %s -> %s after %d attempts. Returning empty.", srcToken, dstToken, maxRetries)
	return nil, nil
}

func generateTokenPairs(tokens []string) []TokenPair {
    var pairs []TokenPair
    for _, src := range tokens {
        for _, dst := range tokens {
            if src != dst {
                pairs = append(pairs, TokenPair{SrcToken: src, DstToken: dst})
            }
        }
    }
    return pairs
}


// Helper function for HTTP GET with retries and parameters
func fetchWithRetryOrderBook(url string, headers, params map[string]string) ([]byte, error) {
      var result interface{}
       var err error
	operation := func() (interface{}, error) {
		client := &http.Client{}
		req, err := http.NewRequest("GET", url, nil)
		if err != nil {
			return nil, err
		}

		// Add headers
		for key, value := range headers {
			req.Header.Set(key, value)
		}

		// Add query parameters
		query := req.URL.Query()
		for key, value := range params {
			query.Add(key, value)
		}
		req.URL.RawQuery = query.Encode()

		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("unexpected status code: %d", resp.StatusCode)
		}

		return ioutil.ReadAll(resp.Body)
	}

	result, err = Retry(operation, 3, time.Second)
	if err != nil {
		return nil, err
	}
	return result.([]byte), nil
}

// Convert map[string]float64 to map[string]*big.Float
func convertFloat64MapToBigFloat(prices map[string]float64) map[string]*big.Float {
    bigFloatPrices := make(map[string]*big.Float)
    for token, price := range prices {
        bigFloatPrices[token] = big.NewFloat(price)
    }
    return bigFloatPrices
}

func initRedis() {
    redisClient = redis.NewClient(&redis.Options{
        Addr:     os.Getenv("REDIS_HOST") + ":" + os.Getenv("REDIS_PORT"),
        Username: os.Getenv("REDIS_USERNAME"), // Add this for ACL authentication
        Password: os.Getenv("REDIS_PASSWORD"),
        DB:       0, // Default DB
    })

    _, err := redisClient.Ping(context.Background()).Result()
    if err != nil {
        log.Fatalf("Failed to connect to Redis: %v", err)
    }
    log.Println("Connected to Redis.")
}

// Retrieve historical data and update rolling averages
// func fetchAndUpdateHistoricalData(key string, liveData map[string]float64, weight float64) map[string]float64 {
//     ctx := context.Background()
//     historicalDataJSON, err := redisClient.Get(ctx, key).Result()
//     historicalData := make(map[string]float64)

//     if err == nil {
//         err = json.Unmarshal([]byte(historicalDataJSON), &historicalData)
//         if err != nil {
//             log.Printf("Error unmarshalling historical data for %s: %v", key, err)
//         }
//     }

//     for token, liveValue := range liveData {
//         historicalValue, exists := historicalData[token]
//         if exists {
//             historicalData[token] = weight*liveValue + (1-weight)*historicalValue
//         } else {
//             historicalData[token] = liveValue
//         }
//     }

//     updatedDataJSON, _ := json.Marshal(historicalData)
//     redisClient.Set(ctx, key, updatedDataJSON, time.Hour) // Cache for 1 hour

//     return historicalData
// }

func fetchAndUpdateHistoricalData(key string, currentData map[string]float64, weight float64, historicalData []float64) map[string]float64 {
    if currentData == nil {
        log.Printf("fetchAndUpdateHistoricalData: currentData is nil for key: %s", key)
        currentData = make(map[string]float64)
    }

    if len(historicalData) == 0 {
        log.Printf("No historical data available for key: %s. Using only current data.", key)
        return currentData
    }

    // Calculate average of historical data
    sum := 0.0
    for _, value := range historicalData {
        sum += value
    }
    historicalAverage := sum / float64(len(historicalData))

    // Blend current data with historical average
    blendedData := make(map[string]float64)
    for token, currentValue := range currentData {
        blendedValue := weight*historicalAverage + (1-weight)*currentValue
        blendedData[token] = blendedValue
    }

    log.Printf("Blended data for key %s: %+v", key, blendedData)
    return blendedData
}

// Converts map[string]*big.Float to map[string]TokenPrice
func convertToTokenPriceMapWithDecimals(prices map[string]*big.Float, decimalsMap map[string]int) map[string]TokenPrice {
    tokenPriceMap := make(map[string]TokenPrice)
    for token, price := range prices {
        decimals, exists := decimalsMap[token]
        if !exists {
            decimals = 18 // Default to 18 decimals if not found
        }
        tokenPriceMap[token] = TokenPrice{
            Price:    price,
            Decimals: decimals,
        }
    }
    return tokenPriceMap
}

func generateRoutes(marketData MarketData) ([]Route, error) {
    // Step 1: Validate the start token
    if !common.IsHexAddress(marketData.StartToken) {
        return nil, fmt.Errorf("invalid start token address: %s", marketData.StartToken)
    }

    // Step 2: Parse and validate the start amount
    if marketData.StartAmount == nil {
        return nil, fmt.Errorf("startAmount is nil or invalid")
    }
    startAmount := marketData.StartAmount.ToBigInt()
    if startAmount.Cmp(big.NewInt(0)) <= 0 {
        return nil, fmt.Errorf("invalid or non-positive startAmount: %s", startAmount.String())
    }

    // Step 3: Validate the profit threshold
    minProfitThreshold := marketData.ProfitThreshold
    if minProfitThreshold == nil || minProfitThreshold.Cmp(big.NewFloat(0)) <= 0 {
        return nil, fmt.Errorf("invalid or non-positive profitThreshold: %s", minProfitThreshold.Text('f', 6))
    }
    minProfitInt := new(big.Int)
    minProfitThreshold.Int(minProfitInt)
    minProfitFloat := new(big.Float).SetInt(minProfitInt)

    // Step 4: Process and normalize liquidity data
    log.Println("Processing and normalizing liquidity data...")
    normalizedLiquidity, err := processMarketData(marketData)
    if err != nil {
        return nil, fmt.Errorf("error processing market data: %v", err)
    }
    if len(normalizedLiquidity) < 7 {
        return nil, fmt.Errorf("insufficient valid liquidity entries after normalization")
    }
    log.Printf("Generating routes with %d normalized liquidity entries...\n", len(normalizedLiquidity))

    // Step 5: Validate and process the gas price
    if marketData.GasPrice == nil {
        return nil, fmt.Errorf("gas price is missing in market data")
    }
    gasPriceInt := new(big.Int)
    marketData.GasPrice.Int(gasPriceInt)

    // Step 6: Convert TokenPrices for compatibility with decimals
    decimalsMap := map[string]int{
        "0xaf88d065e77c8cc2239327c5edb3a432268e5831": 6,  // USDC
        "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": 6,  // USDT
        "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": 18, // DAI
        "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": 18, // WETH
        "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": 8,  // WBTC
    }
    tokenPricesMap := convertToTokenPriceMapWithDecimals(
        convertFloat64MapToBigFloat(marketData.TokenPrices),
        decimalsMap,
    )

    // Step 7: Convert normalized liquidity into []LiquidityData
    liquidityData := convertToLiquidityData(normalizedLiquidity)

    // Step 8: Build and process the graph
    log.Println("Building the graph from normalized liquidity data...")
    graph, err := buildAndProcessGraph(liquidityData, tokenPricesMap, marketData.GasPrice)
    if err != nil {
        return nil, fmt.Errorf("failed to build graph: %v", err)
    }
    log.Println("Graph built successfully. Starting route evaluation.")

    // Step 9: Extract stable token addresses
    stableTokenAddresses := extractStableTokens(liquidityData)

    // Step 10: Evaluate routes with parallel processing
    var finalRoutes []Route
    var mu sync.Mutex
    var wg sync.WaitGroup

    for _, entry := range liquidityData {
        wg.Add(1)
        go func(entry LiquidityData) {
            defer wg.Done()

            // Compute the optimal route
            path, cost, err := ComputeOptimalRoute(graph, marketData.StartToken, entry.TargetToken, marketData.MaxHops)
            if err != nil || len(path) <= 1 {
                log.Printf("No valid route found from %s to %s: %v", marketData.StartToken, entry.TargetToken, err)
                return
            }

            // Convert cost to *big.Int
            costInt := new(big.Int)
            cost.Int(costInt)

            // Convert entry.DstAmount to *big.Int
            dstAmountInt, _ := entry.DstAmount.Int(new(big.Int))

            // Evaluate route profitability
            profitable, profit := evaluateRouteProfit(
                startAmount,
                path,
                tokenPricesMap,
                gasPriceInt,
                costInt,
                minProfitFloat,
            )

            if profitable {
                mu.Lock()
                finalRoutes = append(finalRoutes, Route{
                    ChainID:     marketData.ChainID,
                    StartToken:  marketData.StartToken,
                    StartAmount: startAmount,
                    Path:        path,
                    Profit:      profit,
                })
                mu.Unlock()
                log.Printf("Profitable route found: %s with profit: %s", strings.Join(path, " ➡️ "), profit.String())
            } else {
                log.Printf("Route %s -> %s skipped: Net profit below threshold", marketData.StartToken, entry.TargetToken)
            }
        }(entry)
    }

    wg.Wait()

    // Step 11: Log summary
    log.Printf("Generated %d profitable routes.\n", len(finalRoutes))

    return finalRoutes, nil
}

func prioritizeUSDCLiquidity(liquidity []LiquidityData) []LiquidityData {
    usdcAddress := "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" // USDC address
    prioritizedLiquidity := []LiquidityData{}
    usdcPairs := make(map[string]LiquidityData) // Map TargetToken -> LiquidityData for USDC pairs

    // Extract USDC-based pairs
    for _, entry := range liquidity {
        if strings.EqualFold(entry.BaseToken, usdcAddress) {
            prioritizedLiquidity = append(prioritizedLiquidity, entry)
            usdcPairs[strings.ToLower(entry.TargetToken)] = entry
        }
    }

    log.Printf("Prioritized liquidity with USDC as BaseToken: %d entries", len(prioritizedLiquidity))

    // Process non-USDC pairs and estimate liquidity using USDC
    for _, entry := range liquidity {
        if !strings.EqualFold(entry.BaseToken, usdcAddress) {
            baseToken := strings.ToLower(entry.BaseToken)

            if usdcLiquidity, exists := usdcPairs[baseToken]; exists {
                // Combine USDC -> BaseToken and BaseToken -> TargetToken for estimation
                estimatedLiquidity := combineLiquidity(usdcLiquidity, entry)

                log.Printf("Estimated liquidity for USDC -> %s -> %s: %s", entry.BaseToken, entry.TargetToken, estimatedLiquidity.DstAmount.String())

                prioritizedLiquidity = append(prioritizedLiquidity, estimatedLiquidity)
            } else {
                log.Printf("No USDC pair found for BaseToken %s. Skipping estimation for %s -> %s.", entry.BaseToken, entry.BaseToken, entry.TargetToken)
            }
        }
    }

    return prioritizedLiquidity
}

func combineLiquidity(usdcLiquidity, nonUSDCEntry LiquidityData) LiquidityData {
    usdcDstAmountInt, _ := usdcLiquidity.DstAmount.Int(new(big.Int))
    nonUSDCEntryDstAmountInt, _ := nonUSDCEntry.DstAmount.Int(new(big.Int))

    combinedDstAmount := new(big.Int).Mul(usdcDstAmountInt, nonUSDCEntryDstAmountInt)
    combinedDstAmount.Div(combinedDstAmount, big.NewInt(1e18))

    combinedDstAmountFloat := new(big.Float).SetInt(combinedDstAmount)

    return LiquidityData{
        BaseToken:  usdcLiquidity.BaseToken,
        TargetToken: nonUSDCEntry.TargetToken,
        DstAmount: combinedDstAmountFloat,
        Gas:       usdcLiquidity.Gas + nonUSDCEntry.Gas,
    }
}


func processAndValidateLiquidity(
    liquidity []LiquidityData,
    tokenPrices map[string]TokenPrice,
    minDstAmount float64,
) []LiquidityData {
    //startTime := time.Now()
  // Start tracking execution time
    var validLiquidity []LiquidityData

    for _, data := range liquidity {
        var validPaths [][][]PathSegment

        // Normalize BaseToken and TargetToken addresses
        baseToken := strings.ToLower(data.BaseToken)
        targetToken := strings.ToLower(data.TargetToken)

        for _, path := range data.Paths {
            var validSegments []PathSegment

            for _, segments := range path {
                for _, segment := range segments {
                    // Normalize token addresses in the path segment
                    fromToken := strings.ToLower(segment.FromTokenAddress)
                    toToken := strings.ToLower(segment.ToTokenAddress)

                    // Validate path segment
                    if segment.Name == "" || segment.Part <= 0 ||
                        !common.IsHexAddress(fromToken) ||
                        !common.IsHexAddress(toToken) {
                        log.Printf("Invalid path segment skipped: %+v", segment)
                        continue
                    }

                    // Check if the price exists for the target token
                    price, exists := tokenPrices[toToken]
                    if !exists {
                        log.Printf("Missing price for token: %s", toToken)
                        continue
                    }

                    // Calculate destination amount in USD
                    dstAmountInUSD, _ := price.Price.Float64() // Convert big.Float to float64
                    dstAmountInUSD *= segment.Part / math.Pow(10, 18)

                    // Check if the destination amount meets the minimum threshold
                    if dstAmountInUSD < minDstAmount {
                        log.Printf("Segment skipped due to insufficient USD value: %f", dstAmountInUSD)
                        continue
                    }

                    // Append valid segment
                    validSegments = append(validSegments, PathSegment{
                        Name:            segment.Name,
                        Part:            segment.Part,
                        FromTokenAddress: fromToken,
                        ToTokenAddress:   toToken,
                    })
                }
            }

            // Only add paths with valid segments
            if len(validSegments) > 0 {
                validPaths = append(validPaths, [][]PathSegment{validSegments})
            }
        }

        // Only add liquidity data with valid paths
        if len(validPaths) > 0 {
            validLiquidity = append(validLiquidity, LiquidityData{
                BaseToken:   baseToken,
                TargetToken: targetToken,
                DstAmount:   data.DstAmount,
                Gas:         data.Gas,
                Paths:       validPaths,
            })
        }
    }

    // Log dropped liquidity entries
    droppedEntries := len(liquidity) - len(validLiquidity)
    if droppedEntries > 0 {
        log.Printf("Dropped %d liquidity entries due to missing token prices or invalid segments.", droppedEntries)
    }

    log.Printf("Validated %d liquidity entries.", len(validLiquidity))
    return validLiquidity
}

func fetchUpdatedLiquidity(payload map[string]interface{}) ([]LiquidityData, error) {
    rawLiquidity, ok := payload["liquidity"].([]interface{})
    if !ok {
        return nil, fmt.Errorf("invalid or missing liquidity data in payload")
    }

    var liquidityData []LiquidityData
    for _, item := range rawLiquidity {
        liquidityItem, ok := item.(map[string]interface{})
        if !ok {
            log.Printf("Skipping invalid liquidity item: %+v", item)
            continue
        }

        // Parse and validate individual liquidity item
        dstAmount := new(big.Int)
        if dstStr, ok := liquidityItem["dstAmount"].(string); ok {
            if _, success := dstAmount.SetString(dstStr, 10); !success {
                log.Printf("Skipping liquidity item due to invalid dstAmount: %+v", liquidityItem)
                continue
            }
        } else {
            log.Printf("Skipping liquidity item due to missing dstAmount: %+v", liquidityItem)
            continue
        }

        var gas int64
        if gasFloat, ok := liquidityItem["gas"].(float64); ok {
            gas = int64(gasFloat) // Convert gas value to int64
        }

        paths, err := parsePaths(liquidityItem["paths"])
        if err != nil {
            log.Printf("Skipping liquidity item due to invalid paths: %+v", liquidityItem)
            continue
        }

        liquidityData = append(liquidityData, LiquidityData{
            BaseToken:   liquidityItem["baseToken"].(string),
            TargetToken: liquidityItem["targetToken"].(string),
            DstAmount:   dstAmount,
            Gas:         float64(gas), // Convert int64 to float64
            Paths:       paths,
        })
    }

    log.Printf("Fetched and parsed liquidity data: %d items", len(liquidityData))
    return liquidityData, nil
}

func parsePaths(rawPaths interface{}) ([][][]PathSegment, error) {
    rawPathList, ok := rawPaths.([]interface{})
    if !ok {
        return nil, fmt.Errorf("invalid paths format")
    }

    var paths [][][]PathSegment
    for _, rawPath := range rawPathList {
        rawPathSegments, ok := rawPath.([]interface{})
        if !ok {
            continue
        }

        var parsedPath [][]PathSegment
        for _, rawSegmentGroup := range rawPathSegments {
            rawSegmentList, ok := rawSegmentGroup.([]interface{})
            if !ok {
                continue
            }

            var segmentGroup []PathSegment
            for _, rawSegment := range rawSegmentList {
                segmentData, ok := rawSegment.(map[string]interface{})
                if !ok {
                    continue
                }

                segment := PathSegment{
                    Name:             segmentData["name"].(string),
                    Part:             segmentData["part"].(float64),
                    FromTokenAddress: segmentData["fromTokenAddress"].(string),
                    ToTokenAddress:   segmentData["toTokenAddress"].(string),
                }
                segmentGroup = append(segmentGroup, segment)
            }

            if len(segmentGroup) > 0 {
                parsedPath = append(parsedPath, segmentGroup)
            }
        }

        if len(parsedPath) > 0 {
            paths = append(paths, parsedPath)
        }
    }

    return paths, nil
}

func parseBigInt(value string) (*big.Int, error) {
    parsedValue := new(big.Int)
    if _, success := parsedValue.SetString(value, 10); !success || parsedValue.Cmp(big.NewInt(0)) <= 0 {
        return nil, fmt.Errorf("invalid big.Int value: %s", value)
    }
    return parsedValue, nil
}

func convertToMapSlice(liquidityData []LiquidityData) [][]map[string]interface{} {
    var liquidityMaps [][]map[string]interface{}
    for _, data := range liquidityData {
        var pathMaps []map[string]interface{}
        for _, path := range data.Paths { // Each path is [][]PathSegment
            for _, segments := range path { // Each segments is []PathSegment
                for _, segment := range segments { // Each segment is a PathSegment
                    pathMaps = append(pathMaps, map[string]interface{}{
                        "name":             segment.Name,
                        "part":             segment.Part,
                        "fromTokenAddress": segment.FromTokenAddress,
                        "toTokenAddress":   segment.ToTokenAddress,
                    })
                }
            }
        }
        liquidityMaps = append(liquidityMaps, pathMaps)
    }
    return liquidityMaps
}

func generateRoutesHTTPHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("Incoming request: %s %s", r.Method, r.URL.Path)

	if r.Method != http.MethodPost {
		log.Printf("Invalid request method: %s", r.Method)
		http.Error(w, "Invalid request method. Only POST is allowed.", http.StatusMethodNotAllowed)
		return
	}

	log.Println("Processing POST request to /generate-routes")

	// Decode the incoming request
	var marketData MarketData
	if err := json.NewDecoder(r.Body).Decode(&marketData); err != nil {
		log.Printf("Failed to decode request body: %v", err)
		http.Error(w, "Invalid request body. Please send valid JSON.", http.StatusBadRequest)
		return
	}

	// Validate required fields
	if marketData.StartToken == "" || marketData.StartAmount == nil || len(marketData.Liquidity) == 0 {
		log.Println("Missing required fields in the request body")
		http.Error(w, "Missing required fields: 'startToken', 'startAmount', or 'liquidity'", http.StatusBadRequest)
		return
	}

	// Convert marketData.StartAmount to a string for comparison
	startAmount := marketData.StartAmount.ToBigInt() // Use ToBigInt() to convert *BigInt to *big.Int
	if startAmount == nil {
		log.Println("Invalid 'startAmount' value in the request body")
		http.Error(w, "Invalid 'startAmount' value", http.StatusBadRequest)
		return
	}

	startAmountStr := startAmount.String() // Convert *big.Int to string for comparison
	if marketData.StartToken == "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" || startAmountStr == "100000000000000000000000" {
		log.Println("Invalid 'startToken' or 'startAmount' value in the request body")
		http.Error(w, "Invalid 'startToken' or 'startAmount' value", http.StatusBadRequest)
		return
	}

	// Process and normalize market data
	routes, err := generateRoutes(marketData)
	if err != nil {
		log.Printf("Error generating routes: %v", err)
		http.Error(w, "Failed to generate routes. Internal server error.", http.StatusInternalServerError)
		return
	}

	response := struct {
		Routes []Route `json:"routes"`
	}{
		Routes: routes,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Failed to encode response: %v", err)
		http.Error(w, "Failed to encode response. Internal server error.", http.StatusInternalServerError)
		return
	}

	log.Println("Routes generated and sent successfully.")
}


func flattenTokenPrices(nestedPrices map[string]map[string]TokenPrice) map[string]TokenPrice {
    flatPrices := make(map[string]TokenPrice)
    for _, innerMap := range nestedPrices {
        for token, price := range innerMap {
            flatPrices[token] = price
        }
    }
    return flatPrices
}

func extractGasPriceFromLiquidity(liquidityData []LiquidityData) *big.Float {
    totalGas := big.NewInt(0)
    count := 0

    for _, entry := range liquidityData {
        if entry.Gas < 0 {
            log.Printf("Skipping entry with negative gas value: %d", entry.Gas)
            continue
        }
        // Convert `entry.Gas` to uint64 before using `SetUint64`
        totalGas.Add(totalGas, new(big.Int).SetUint64(uint64(entry.Gas)))
        count++
    }

    if count == 0 {
        return big.NewFloat(1.0) // Default gas price if no data is available
    }

    avgGas := new(big.Float).Quo(new(big.Float).SetInt(totalGas), big.NewFloat(float64(count)))
    return avgGas
}


func convertTokenPricesToMap(rawPrices map[string]float64, liquidityData []LiquidityData) map[string]map[string]TokenPrice {
    tokenPrices := make(map[string]map[string]TokenPrice)

    for _, entry := range liquidityData {
        // Normalize BaseToken and TargetToken addresses to lowercase
        baseToken := strings.ToLower(entry.BaseToken)
        targetToken := strings.ToLower(entry.TargetToken)

        // Ensure BaseToken price exists
        if _, baseExists := rawPrices[baseToken]; !baseExists {
            log.Printf("Skipping BaseToken %s due to missing price", baseToken)
            continue
        }

        // Ensure TargetToken price exists
        targetPrice, targetExists := rawPrices[targetToken]
        if !targetExists {
            log.Printf("Skipping TargetToken %s due to missing price", targetToken)
            continue
        }

        // Initialize map for BaseToken if not present
        if _, exists := tokenPrices[baseToken]; !exists {
            tokenPrices[baseToken] = make(map[string]TokenPrice)
        }

        // Map BaseToken -> TargetToken
        tokenPrices[baseToken][targetToken] = TokenPrice{
            Price:     new(big.Float).SetFloat64(targetPrice),
            Liquidity: new(big.Float).SetInt(entry.DstAmount),
        }
    }

    log.Printf("Converted token prices map with %d entries.", len(tokenPrices))
    return tokenPrices
}

// Converts [][]map[string]interface{} back to []LiquidityData
func convertToLiquidityData(entries []LiquidityEntry) []LiquidityData {
    liquidityData := make([]LiquidityData, len(entries))

    for i, entry := range entries {
        // Convert gas dynamically from the entry
        gasInt := int64(entry.Gas)

        // Construct individual path segment
        segment := PathSegment{
            Name:             fmt.Sprintf("%s -> %s", entry.BaseToken, entry.TargetToken),
            Part:             100, // Assume 100% allocation for simplicity
            FromTokenAddress: entry.BaseToken,
            ToTokenAddress:   entry.TargetToken,
        }

        // Wrap the segment in [][]PathSegment, and then wrap that in [][][]PathSegment
        paths := [][][]PathSegment{
            {
                {segment}, // Wrap each segment in the required nesting structure
            },
        }

        // Convert NormalizedPrice from float64 to *big.Float
        normalizedPrice := new(big.Float).SetFloat64(entry.NormalizedPrice)

        // Populate LiquidityData (fields adjusted to avoid undefined fields)
        liquidityData[i] = LiquidityData{
            BaseToken:      entry.BaseToken,
            TargetToken:    entry.TargetToken,
            NormalizedPrice: normalizedPrice, // Convert NormalizedPrice to *big.Float
            DstAmount:      entry.DstAmount,  // Use DstAmount from the entry
            Gas:            gasInt,          // Dynamically calculate gas
            Paths:          paths,           // Assign paths with nested structure
        }
    }

    return liquidityData
}



func adjustForTokenDecimals(token string, amount *big.Int) (*big.Int, error) {
    tokenDecimals := getTokenDecimals(token)
    if tokenDecimals < 0 {
        return nil, fmt.Errorf("unable to fetch token decimals for token: %s", token)
    }

    adjustedAmount := new(big.Int).Mul(amount, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(tokenDecimals)), nil))
    if adjustedAmount.Cmp(big.NewInt(0)) <= 0 {
        return nil, fmt.Errorf("invalid adjusted amount for token decimals")
    }

    return adjustedAmount, nil
}

// Helper function to flatten [][]map[string]interface{} to []map[string]interface{}
func flattenLiquidity(nestedLiquidity [][]map[string]interface{}) []map[string]interface{} {
    var flattened []map[string]interface{}
    for _, liquidityPairs := range nestedLiquidity {
        for _, protocol := range liquidityPairs {
            flattened = append(flattened, protocol)
        }
    }
    return flattened
}

// fetchTokenDecimalsFromBlockchain queries the blockchain to retrieve token decimals
func fetchTokenDecimalsFromBlockchain(tokenAddress string) (int, error) {
	client, err := getEthClient()
	if err != nil {
		return -1, fmt.Errorf("failed to connect to Ethereum client: %v", err)
	}

	erc20ABI := `[{"constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"type":"function"}]`
	parsedABI, err := abi.JSON(strings.NewReader(erc20ABI))
	if err != nil {
		return -1, fmt.Errorf("failed to parse ERC20 ABI: %v", err)
	}

	address := common.HexToAddress(tokenAddress)
	callData, err := parsedABI.Pack("decimals")
	if err != nil {
		return -1, fmt.Errorf("failed to pack ABI call: %v", err)
	}

	msg := ethereum.CallMsg{
		To:   &address,
		Data: callData,
	}
	result, err := client.CallContract(context.Background(), msg, nil)
	if err != nil {
		return -1, fmt.Errorf("failed to call contract: %v", err)
	}

	decimals := new(big.Int)
	decimals.SetBytes(result)
	return int(decimals.Int64()), nil
}

// computeProfitableRoutes calculates profitable routes based on token prices and liquidity
func computeProfitableRoutes(tokenPrices map[string]float64, liquidity []map[string]interface{}) ([]Route, error) {
	if len(tokenPrices) == 0 || len(liquidity) == 0 {
		return nil, fmt.Errorf("insufficient market data for route computation")
	}

	var routes []Route
	for _, liquidityEntry := range liquidity {
		fromToken, ok := liquidityEntry["fromToken"].(string)
		if !ok {
			log.Println("Skipping entry: invalid fromToken")
			continue
		}
		toToken, ok := liquidityEntry["toToken"].(string)
		if !ok {
			log.Println("Skipping entry: invalid toToken")
			continue
		}
		liquidityValue, ok := liquidityEntry["liquidity"].(float64)
		if !ok || liquidityValue <= 0 {
			log.Println("Skipping entry: invalid or zero liquidity")
			continue
		}

		// Calculate profit
		fromPrice, fromExists := tokenPrices[fromToken]
		toPrice, toExists := tokenPrices[toToken]
		if !fromExists || !toExists || fromPrice <= 0 || toPrice <= 0 {
			log.Printf("Skipping pair %s -> %s due to missing or invalid prices", fromToken, toToken)
			continue
		}

		profit := liquidityValue * (toPrice / fromPrice)
		if profit > 0 {
			routes = append(routes, Route{
				Path:   []string{fromToken, toToken},
				Profit: big.NewInt(int64(profit * 1e18)), // Convert to Wei
			})
		}
	}

	if len(routes) == 0 {
		log.Println("No profitable routes found")
		return nil, fmt.Errorf("no profitable routes detected")
	}

	log.Printf("Computed %d profitable routes", len(routes))
	return routes, nil
}

func getTokenDecimals(tokenAddress string) int {
	// Example: Fetch decimals from a hardcoded list or blockchain query
	hardcodedDecimals := map[string]int{
		"0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9": 6,  // USDT
		"0xaf88d065e77c8cC2239327C5EDb3A432268e5831": 6,  // USDC
		"0xda10009cbd5d07dd0cecc66161fc93d7c9000da1": 18, // DAI
                "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": 18,//weth
                "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": 8,//wbtc
	}

	if decimals, exists := hardcodedDecimals[strings.ToLower(tokenAddress)]; exists {
		return decimals
	}

	// Fallback: Query blockchain for token decimals (requires Ethereum client)
	decimals, err := fetchTokenDecimalsFromBlockchain(tokenAddress)
	if err != nil {
		log.Printf("Failed to fetch token decimals for %s: %v", tokenAddress, err)
		return -1
	}

	return decimals
}

func handleClientReconnection(client *WebSocketClient) {
	for {
		_, _, err := client.Conn.ReadMessage()
		if err != nil {
			log.Printf("Client disconnected. Attempting reconnection: %v", err)
			client.Disconnected <- true
			return
		}
	}
}


func filterRoutes(routes []Route, startToken string, profitThreshold *big.Int) []Route {
    var filtered []Route
    for _, route := range routes {
        if strings.EqualFold(route.StartToken, startToken) && route.Profit.Cmp(profitThreshold) > 0 {
            filtered = append(filtered, route)
        }
    }
    log.Printf("Filtered %d routes based on profit threshold.", len(filtered))
    return filtered
}

// FetchGasPrice fetches the current gas price with caching and retry logic
func fetchGasPrice() (*big.Int, error) {
	gasPriceCache.RLock()
	if gasPriceCache.price != nil && time.Since(gasPriceCache.timestamp) < cacheDuration {
		gasPriceCache.RUnlock()
		return gasPriceCache.price, nil
	}
	gasPriceCache.RUnlock()

	const maxRetries = 3
	var gasPrices []float64

	// Fetch gas prices from recent blocks
	for i := 0; i < maxRetries; i++ {
		resp, err := http.Get("https://api.blocknative.com/gasprices/blockprices")
		if err != nil {
			time.Sleep(1 * time.Second)
			continue
		}
		defer resp.Body.Close()

		var result struct {
			BlockPrices []struct {
				BaseFeePerGas float64 `json:"baseFeePerGas"`
			} `json:"blockPrices"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			time.Sleep(1 * time.Second)
			continue
		}

		for _, block := range result.BlockPrices {
			gasPrices = append(gasPrices, block.BaseFeePerGas)
		}

		break
	}

	if len(gasPrices) == 0 {
		log.Println("Failed to fetch gas prices, using fallback value: 50 Gwei.")
		return big.NewInt(50 * 1e9), nil // 50 Gwei fallback
	}

	// Calculate average gas price
	var total float64
	for _, price := range gasPrices {
		total += price
	}
	avgGasPriceGwei := total / float64(len(gasPrices))
	gasPriceWei := new(big.Int).Mul(big.NewInt(int64(avgGasPriceGwei)), big.NewInt(1e9))

	// Update cache
	gasPriceCache.Lock()
	gasPriceCache.price = gasPriceWei
	gasPriceCache.timestamp = time.Now()
	gasPriceCache.Unlock()

	return gasPriceWei, nil
}

// Initialize shared Ethereum client with connection pooling
func getEthClient() (*ethclient.Client, error) {
	var err error
	clientOnce.Do(func() {
		rpcURL := os.Getenv("RPC_URL")
		if rpcURL == "" {
			err = errors.New("RPC_URL environment variable is not set")
			return
		}
		sharedClient, err = ethclient.Dial(rpcURL)
		if err != nil {
			log.Fatalf("Failed to initialize Ethereum client: %v", err)
		}
	})
	return sharedClient, err
}


// Validate and fetch environment variables
func validateEnvVars(vars []string) error {
	for _, key := range vars {
		if os.Getenv(key) == "" {
			return fmt.Errorf("missing environment variable: %s", key)
		}
	}
	return nil
}

func sendTransaction(tx Transaction, token string) (*Receipt, error) {
    // Validate required environment variables
    requiredVars := []string{"ONEINCH_API_KEY", "INFURA_URL", "PRIVATE_KEY", "NODE_URL"}
    if err := validateEnvVars(requiredVars); err != nil {
        log.Fatalf("Environment validation failed: %v", err)
    }

    // Use shared Ethereum client
    client, err := getEthClient()
    if err != nil {
        return nil, fmt.Errorf("failed to connect to Ethereum client: %v", err)
    }

    // Fetch Permit2 signature from Node.js
    permitDetails, err := fetchPermit2Signature(token, tx.To, tx.Value.String())
    if err != nil {
        return nil, fmt.Errorf("failed to fetch Permit2 signature: %v", err)
    }

    // Convert gas price from *big.Float to *big.Int
    gasPrice := convertBigFloatToInt(tx.GasPrice) // Utilize helper function
    if gasPrice.Cmp(big.NewInt(0)) <= 0 {
        return nil, fmt.Errorf("invalid gas price: %s", gasPrice.String())
    }

    // Parse gas limit and recipient address
    gasLimit := uint64(tx.Gas)
    toAddress := common.HexToAddress(tx.To)

    // Create transaction data
    rawTx := types.NewTransaction(
        permitDetails.Nonce,          // Use fetched nonce
        toAddress,                    // Recipient address
        new(big.Int).Set(tx.Value),   // Value in Wei
        gasLimit,                     // Gas limit
        gasPrice,                     // Gas price in Wei
        common.FromHex(tx.Data),      // Transaction data
    )

    // Load private key for signing
    privateKey, err := crypto.HexToECDSA(os.Getenv("PRIVATE_KEY"))
    if err != nil {
        return nil, fmt.Errorf("failed to load private key: %v", err)
    }

    // Fetch the current chain ID
    chainID, err := client.NetworkID(context.Background())
    if err != nil {
        return nil, fmt.Errorf("failed to fetch chain ID: %v", err)
    }

    // Sign the transaction
    signedTx, err := types.SignTx(rawTx, types.NewEIP155Signer(chainID), privateKey)
    if err != nil {
        return nil, fmt.Errorf("failed to sign transaction: %v", err)
    }

    // Send the signed transaction
    err = client.SendTransaction(context.Background(), signedTx)
    if err != nil {
        return nil, fmt.Errorf("failed to send transaction: %v", err)
    }

    // Log the transaction hash
    txHash := signedTx.Hash().Hex()
    log.Printf("Transaction sent successfully. Hash: %s", txHash)

    // Notify the Node.js script
    notificationPayload := map[string]string{
        "txHash": txHash,
        "token":  token,
        "value":  tx.Value.String(),
    }
    if err := notifyNodeJS(notificationPayload); err != nil {
        log.Printf("Failed to notify Node.js script: %v", err)
    }

    return &Receipt{TransactionHash: txHash}, nil
}

func notifyNodeJS(payload map[string]string) error {
    nodeURL := os.Getenv("NODE_URL") // Node.js script URL
    if nodeURL == "" {
        return fmt.Errorf("NODE_URL environment variable is not set")
    }

    // Encode the payload as JSON
    jsonData, err := json.Marshal(payload)
    if err != nil {
        return fmt.Errorf("failed to marshal payload: %v", err)
    }

    // Send the notification via HTTP POST
    resp, err := http.Post(nodeURL, "application/json", bytes.NewBuffer(jsonData))
    if err != nil {
        return fmt.Errorf("failed to send notification: %v", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("received non-OK response from Node.js script: %d", resp.StatusCode)
    }

    log.Println("Notification sent to Node.js script successfully")
    return nil
}


// FetchTokenPrices fetches prices for tokens using concurrent API calls
func FetchTokenPrices(tokens []string) (map[string]float64, error) {
    cacheKey := strings.Join(tokens, ",")
    if cachedData, exists := getFromTokenPriceCache(cacheKey); exists {
        return cachedData.(map[string]float64), nil
    }

    prices := make(map[string]float64)
    for _, token := range tokens {
        price, err := fetchTokenPrice(token)
        if err != nil {
            log.Printf("Failed to fetch price for token %s: %v", token, err)
            continue
        }
        prices[token] = price
    }
    setToTokenPriceCache(cacheKey, prices)
    return prices, nil
}

// Fetch token price from the 1inch API
func fetchTokenPrice(token string) (float64, error) {
	// Construct the API URL
	url := fmt.Sprintf("%s/%s", oneInchPriceAPI, token)

	// Add a delay to respect the 1rps rate limit
	time.Sleep(time.Second)

	// Make the API request
	resp, err := http.Get(url)
	if err != nil {
		return 0, fmt.Errorf("failed to fetch token price: %w", err)
	}
	defer resp.Body.Close()

	// Check for non-200 status code
	if resp.StatusCode != http.StatusOK {
		body, _ := ioutil.ReadAll(resp.Body)
		return 0, fmt.Errorf("unexpected status code %d: %s", resp.StatusCode, string(body))
	}

	// Parse the JSON response
	var result struct {
		Price float64 `json:"price"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return 0, fmt.Errorf("failed to parse token price response: %w", err)
	}

	return result.Price, nil
}

func extractStableTokens(liquidityData []LiquidityData) []string {
    stableTokens := make(map[string]bool) // Use a map to avoid duplicates

    for _, entry := range liquidityData {
        if contains(hardcodedStableAddresses, entry.BaseToken) {
            stableTokens[entry.BaseToken] = true
        }
        if contains(hardcodedStableAddresses, entry.TargetToken) {
            stableTokens[entry.TargetToken] = true
        }
    }

    // Convert the map keys to a slice
    stableTokenList := make([]string, 0, len(stableTokens))
    for token := range stableTokens {
        stableTokenList = append(stableTokenList, token)
    }

    return stableTokenList
}

// Helper function to check if a slice contains a string
func contains(slice []string, item string) bool {
    for _, v := range slice {
        if strings.EqualFold(v, item) {
            return true
        }
    }
    return false
}


func executeRoute(route []string, CAPITAL *big.Int) error {
    const maxRetries = 3
    const initialBackoff = time.Second

    // Step 1: Fetch gas price
    gasPrice, err := retryWithBackoff(maxRetries, initialBackoff, fetchGasPrice)
    if err != nil {
        return fmt.Errorf("failed to fetch gas price: %w", err)
    }

    // Step 2: Adjust trade size
    scaledAmount, err := adjustTradeSizeForGas(CAPITAL, gasPrice)
    if err != nil {
        return fmt.Errorf("failed to adjust trade size: %w", err)
    }

    // Step 3: Approve tokens
    if err := retryWithBackoffError(maxRetries, initialBackoff, func() error {
        return approveTokensNode(route, scaledAmount)
    }); err != nil {
        return fmt.Errorf("token approval failed: %w", err)
    }

    // Step 4: Construct transaction parameters
    params, err := constructParams(route, scaledAmount, "")
    if err != nil {
        return fmt.Errorf("failed to construct transaction parameters: %w", err)
    }

    // Step 5: Estimate gas
    gasEstimate, err := retryWithBackoff(maxRetries, initialBackoff, func() (*big.Int, error) {
        return estimateGas(route, CAPITAL)
    })
    if err != nil {
        return fmt.Errorf("gas estimation failed: %w", err)
    }

    // Step 6: Execute transaction
    tx := Transaction{
        From:     os.Getenv("WALLET_ADDRESS"),
        To:       os.Getenv("CONTRACT_ADDRESS"),
        Data:     params,
        Gas:      gasEstimate.Uint64(),
        GasPrice: gasPrice,
    }
    receipt, err := retryWithBackoff(maxRetries, initialBackoff, func() (*Receipt, error) {
        return sendTransaction(tx, "token")
    })
    if err != nil {
        notifyNode("execution_error", fmt.Sprintf("Error executing route: %v", err))
        return fmt.Errorf("transaction execution failed: %w", err)
    }

    log.Printf("Transaction successful. Hash: %s", receipt.TransactionHash)
    return nil
}



// retryWithBackoff retries a function with exponential backoff.
func retryWithBackoff[T any](maxRetries int, initialBackoff time.Duration, fn func() (T, error)) (T, error) {
    var result T
    var err error
    for i := 0; i < maxRetries; i++ {
        result, err = fn()
        if err == nil {
            return result, nil
        }
        time.Sleep(initialBackoff * time.Duration(i+1))
    }
    return result, err
}

// Wrapper for `error`-only Functions:
func retryWithBackoffError(maxRetries int, initialBackoff time.Duration, fn func() error) error {
    _, err := retryWithBackoff(maxRetries, initialBackoff, func() (struct{}, error) {
        return struct{}{}, fn()
    })
    return err
}

func cacheSet(key string, value interface{}, ttl time.Duration) {
    tokenPriceCache.mu.Lock()
    defer tokenPriceCache.mu.Unlock()
    tokenPriceCache.cache[key] = value
    go func() {
        time.Sleep(ttl)
        tokenPriceCache.mu.Lock()
        delete(tokenPriceCache.cache, key)
        tokenPriceCache.mu.Unlock()
    }()
}


// Helper function to set cache with expiration for token prices
func cacheSetTokenPrices(key string, value interface{}, duration time.Duration) {
    tokenPriceCache.mu.Lock()
    defer tokenPriceCache.mu.Unlock()
    tokenPriceCache.cache[key] = CacheEntry{
        Data:      value,
        Timestamp: time.Now().Add(duration),
    }
}

// Helper function to get cache for token prices
func cacheGetTokenPrices(key string) (interface{}, bool) {
    tokenPriceCache.mu.Lock()
    defer tokenPriceCache.mu.Unlock()
    entry, exists := tokenPriceCache.cache[key]
    if exists {
        cachedEntry := entry.(CacheEntry)
        if time.Now().Before(cachedEntry.Timestamp) {
            return cachedEntry.Data, true
        }
    }
    delete(tokenPriceCache.cache, key) // Remove expired entry
    return nil, false
}

// Helper function to fetch token prices with retries
func fetchWithRetryTokenPrices(url string, headers map[string]string, backoff time.Duration) ([]byte, error) {
	client := &http.Client{}
	var err error
	for attempt := 1; attempt <= 3; attempt++ {
		req, reqErr := http.NewRequest("GET", url, nil)
		if reqErr != nil {
			return nil, fmt.Errorf("failed to create request: %v", reqErr)
		}

		// Add headers
		for key, value := range headers {
			req.Header.Set(key, value)
		}

		resp, respErr := client.Do(req)
		if respErr != nil {
			err = respErr
			log.Printf("Request failed (attempt %d): %v", attempt, respErr)
		} else {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return ioutil.ReadAll(resp.Body)
			}
			if resp.StatusCode == 429 {
				log.Printf("Rate limit hit. Retrying in %v...", backoff)
				time.Sleep(backoff)
				backoff *= 2
			} else {
				body, _ := ioutil.ReadAll(resp.Body)
				return nil, fmt.Errorf("unexpected status code %d: %s", resp.StatusCode, string(body))
			}
		}
	}
	return nil, fmt.Errorf("failed to fetch data after retries: %v", err)
}

func convertToUSD(amount *big.Int, price *big.Float, decimals int) *big.Float {
    amountFloat := new(big.Float).SetInt(amount) // Fix for *big.Int to *big.Float conversion
    scale := new(big.Float).SetInt(big.NewInt(int64(math.Pow10(decimals))))
    return new(big.Float).Quo(new(big.Float).Mul(amountFloat, price), scale)
}

func filterValidAddresses(tokens []StableToken) []string {
	var addresses []string
	for _, token := range tokens {
		if common.IsHexAddress(token.Address) {
			addresses = append(addresses, token.Address)
		}
	}
	return addresses
}

func buildAndProcessGraph(
    liquidity []LiquidityData,
    tokenPrices map[string]TokenPrice,
    gasPrice *big.Float,
) (*WeightedGraph, error) {
    graph := &WeightedGraph{
        AdjacencyList: make(map[string]map[string]EdgeWeight),
        TokenPrices:   make(map[string]*big.Float),
    }

    // Flatten token prices for easy lookup
    for token, priceData := range tokenPrices {
        graph.TokenPrices[strings.ToLower(token)] = priceData.Price
    }

    var tokenPairs []TokenPair
    for _, entry := range liquidity {
        baseToken := strings.ToLower(entry.BaseToken)
        targetToken := strings.ToLower(entry.TargetToken)

        if entry.DstAmount.Cmp(big.NewInt(0)) <= 0 || entry.Gas <= 0 {
            log.Printf("Skipping invalid entry: BaseToken=%s, TargetToken=%s, DstAmount=%s, Gas=%d",
                baseToken, targetToken, entry.DstAmount.String(), entry.Gas)
            continue
        }

        dstPrice, exists := tokenPrices[targetToken]
        if !exists || dstPrice.Price == nil {
            log.Printf("Skipping entry due to missing or invalid token price: %s -> %s",
                baseToken, targetToken)
            continue
        }

        decimals := 18 // Default decimals for tokens, update if dynamic
        dstAmountUSD := convertToUSD(entry.DstAmount, dstPrice.Price, decimals)
        dstAmountUSDValue, accuracy := dstAmountUSD.Float64()
        if accuracy != big.Exact || dstAmountUSDValue <= 0 {
            log.Printf("Skipping entry with invalid USD value: %s -> %s, USD=%f",
                baseToken, targetToken, dstAmountUSDValue)
            continue
        }

        weight := calculateWeightFromLiquidity(dstAmountUSDValue, float64(entry.Gas))
        const maxWeight = 1e6
        if weight > maxWeight {
            log.Printf("Capping weight: Original=%f, Capped=%f", weight, maxWeight)
            weight = maxWeight
        } else if weight < -maxWeight {
            log.Printf("Capping weight: Original=%f, Capped=%f", weight, -maxWeight)
            weight = -maxWeight
        }

        tokenPairs = append(tokenPairs, TokenPair{
            SrcToken: baseToken,
            DstToken: targetToken,
            Weight:   weight,
        })
    }

    constructedGraph, err := BuildGraph(tokenPairs, graph.TokenPrices)
    if err != nil {
        return nil, fmt.Errorf("failed to build graph: %v", err)
    }

    totalEdges := countEdges(constructedGraph)
    log.Printf("Graph constructed with %d nodes and %d edges.", len(constructedGraph.AdjacencyList), totalEdges)

    for node, neighbors := range constructedGraph.AdjacencyList {
        neighborKeys := []string{}
        for neighbor := range neighbors {
            neighborKeys = append(neighborKeys, neighbor)
        }
        log.Printf("Node: %s | Neighbors: %v", node, neighborKeys)
    }

    return constructedGraph, nil
}

// Updated convertToTokenPairsWithWeights function
func convertToTokenPairsWithWeights(liquidityData []LiquidityData) []TokenPair {
    var tokenPairs []TokenPair

    for _, entry := range liquidityData {
        // Parse dstAmount
        dstAmount, err := parseDstAmount(entry.DstAmount.String()) // Convert *big.Int to string
        if err != nil {
            log.Printf("Skipping invalid dstAmount in liquidity entry: %v", err)
            continue
        }

        gas := float64(entry.Gas)

        // Calculate weight using dstAmount and gas
        weight := calculateWeightFromLiquidity(dstAmount, gas)

        // Normalize addresses before appending to token pairs
        srcToken := strings.ToLower(entry.BaseToken)
        dstToken := strings.ToLower(entry.TargetToken)

        // Append token pair with normalized addresses and calculated weight
        tokenPairs = append(tokenPairs, TokenPair{
            SrcToken: srcToken,
            DstToken: dstToken,
            Weight:   weight,
        })
    }

    return tokenPairs
}

// Updated convertToTokenPairs function
func convertToTokenPairs(liquidityData []LiquidityData) []TokenPair {
    var tokenPairs []TokenPair

    for _, data := range liquidityData {
        for _, path := range data.Paths { // Iterate over [][][]PathSegment
            for _, segments := range path { // Iterate over [][]PathSegment
                for _, segment := range segments { // Iterate over []PathSegment
                    tokenPairs = append(tokenPairs, TokenPair{
                        SrcToken: segment.FromTokenAddress,
                        DstToken: segment.ToTokenAddress,
                    })
                }
            }
        }
    }

    return tokenPairs
}

func BuildGraph(tokenPairs []TokenPair, tokenPrices map[string]*big.Float) (*WeightedGraph, error) {
    graph := &WeightedGraph{
        AdjacencyList: make(map[string]map[string]EdgeWeight),
        TokenPrices:   tokenPrices,
    }

    var wg sync.WaitGroup
    edgeChan := make(chan struct {
        SrcToken   string
        DstToken   string
        EdgeWeight EdgeWeight
    }, len(tokenPairs))

    for _, pair := range tokenPairs {
        wg.Add(1)
        go func(pair TokenPair) {
            defer wg.Done()

            srcToken := strings.ToLower(pair.SrcToken)
            dstToken := strings.ToLower(pair.DstToken)
            weight := new(big.Float).SetFloat64(pair.Weight)

            edgeWeight := EdgeWeight{
                Weight:    weight,
                Liquidity: big.NewFloat(1), // Replace with actual liquidity if available
            }

            edgeChan <- struct {
                SrcToken   string
                DstToken   string
                EdgeWeight EdgeWeight
            }{
                SrcToken:   srcToken,
                DstToken:   dstToken,
                EdgeWeight: edgeWeight,
            }
        }(pair)
    }

    go func() {
        wg.Wait()
        close(edgeChan)
    }()

  for edge := range edgeChan {
    if graph.AdjacencyList[edge.SrcToken] == nil {
        graph.AdjacencyList[edge.SrcToken] = make(map[string]EdgeWeight)
    }
    graph.AdjacencyList[edge.SrcToken][edge.DstToken] = edge.EdgeWeight

    if graph.AdjacencyList[edge.DstToken] == nil {
        graph.AdjacencyList[edge.DstToken] = make(map[string]EdgeWeight)
    }
    graph.AdjacencyList[edge.DstToken][edge.SrcToken] = edge.EdgeWeight

    // Extract the float64 value for the weight
    weightFloat, _ := edge.EdgeWeight.Weight.Float64()

    // Call logEdgeDetails with appropriate arguments
    logEdgeDetails(
        edge.SrcToken,
        edge.DstToken,
        weightFloat, // Use the extracted float64 value
        edge.EdgeWeight.Liquidity,
    )
}
    optimizeGraphConstruction(graph)

    if len(graph.AdjacencyList) == 0 {
        log.Println("Graph is empty. No edges were added.")
        return nil, fmt.Errorf("no edges added to the graph")
    }

    totalEdges := countEdges(graph)
    log.Printf("Graph constructed with %d nodes and %d edges.", len(graph.AdjacencyList), totalEdges)

    return graph, nil
}


// countEdges counts the total number of edges in the graph.
func countEdges(graph *WeightedGraph) int {
    totalEdges := 0
    for _, neighbors := range graph.AdjacencyList {
        totalEdges += len(neighbors)
    }
    return totalEdges
}


func adjustProfitThreshold(baseThreshold float64, gasPrice *big.Float, volatilityFactor float64) float64 {
    gasPriceFloat, _ := gasPrice.Float64() // Convert *big.Float to float64
    return baseThreshold + gasPriceFloat*volatilityFactor
}

func calculateWeightFromLiquidity(dstAmount, gas float64) float64 {
    if dstAmount <= 0 || gas <= 0 {
        log.Printf("Invalid parameters for weight calculation: dstAmount=%f, gas=%f", dstAmount, gas)
        return math.MaxFloat64 // Assign maximum weight for invalid entries
    }

    weightFactor := getEnvAsFloat("WEIGHT_FACTOR", 1.0)
    liquidityFactor := getEnvAsFloat("LIQUIDITY_FACTOR", 1.0)

    // Weight calculation logic
    weight := (math.Log(dstAmount+1) * weightFactor) / (math.Log(gas+1) * liquidityFactor)

    // Cap extreme weight values
    const maxWeight = 1e6
    if weight > maxWeight {
        log.Printf("Weight capped: Original=%f, Capped=%f", weight, maxWeight)
        weight = maxWeight
    }
    if weight < -maxWeight {
        log.Printf("Weight capped: Original=%f, Capped=%f", weight, -maxWeight)
        weight = -maxWeight
    }

    log.Printf("Weight calculated: dstAmount=%f, gas=%f, weight=%f", dstAmount, gas, weight)
    return weight
}


// Helper function to fetch environment variables as floats
func getEnvAsFloat(key string, defaultValue float64) float64 {
    value := os.Getenv(key)
    if value == "" {
        return defaultValue
    }
    if floatValue, err := strconv.ParseFloat(value, 64); err == nil {
        return floatValue
    }
    return defaultValue
}

// Updated MonitorMarketAndRebuildGraph function
func MonitorMarketAndRebuildGraph(
    payload map[string]interface{},
    updateInterval time.Duration,
    graphChan chan *WeightedGraph,
    baseThreshold float64,
    volatilityFactor float64,
) {
    ticker := time.NewTicker(updateInterval)
    defer ticker.Stop()

    for range ticker.C {
        log.Println("Fetching latest liquidity and market data for graph update...")

        // Fetch updated liquidity
        updatedLiquidity, err := fetchUpdatedLiquidity(payload)
        if err != nil {
            log.Printf("Failed to fetch updated liquidity: %v", err)
            continue
        }

        // Fetch current gas price
        gasPrice, err := fetchCurrentGasPrice(payload)
        if err != nil {
            log.Printf("Failed to fetch current gas price: %v", err)
            continue
        }

        // Adjust profit threshold dynamically
        adjustedThreshold := adjustProfitThreshold(baseThreshold, gasPrice, volatilityFactor)

        // Convert rawTokenPrices to a nested TokenPrice map
        rawTokenPrices := payload["tokenPrices"].(map[string]float64)
        nestedTokenPrices := convertTokenPricesToMap(rawTokenPrices, updatedLiquidity)
        flatTokenPrices := flattenTokenPrices(nestedTokenPrices)

        // Validate token prices
        validatedLiquidity := validateTokenPrices(nestedTokenPrices, updatedLiquidity)
        if len(validatedLiquidity) == 0 {
            log.Println("No valid liquidity entries after token price validation. Skipping this cycle.")
            continue
        }

        // Validate and filter liquidity using validated token prices
        filteredLiquidity := processAndValidateLiquidity(validatedLiquidity, flatTokenPrices, adjustedThreshold)

        // Build and process the graph
        graph, err := buildAndProcessGraph(filteredLiquidity, flatTokenPrices, gasPrice)
        if err != nil {
            log.Printf("Failed to build graph: %v", err)
            continue
        }

        // Log the graph update success
        log.Println("Graph updated successfully.")

        // Send updated graph through the channel
        graphChan <- graph
    }
}

func validateTokenPrices(tokenPrices map[string]map[string]TokenPrice, liquidityData []LiquidityData) []LiquidityData {
    validLiquidity := []LiquidityData{}

    for _, entry := range liquidityData {
        baseToken := strings.ToLower(entry.BaseToken)
        targetToken := strings.ToLower(entry.TargetToken)

        if _, baseExists := tokenPrices[baseToken]; !baseExists {
            log.Printf("Skipping entry: BaseToken %s has no valid price.", baseToken)
            continue
        }

        if _, targetExists := tokenPrices[baseToken][targetToken]; !targetExists {
            log.Printf("Skipping entry: TargetToken %s has no valid price.", targetToken)
            continue
        }

        validLiquidity = append(validLiquidity, entry)
    }

    log.Printf("Validated %d out of %d liquidity entries.", len(validLiquidity), len(liquidityData))
    return validLiquidity
}


// Helper to convert token prices
func convertTokenPrices(rawTokenPrices map[string]interface{}) map[string]float64 {
    tokenPrices := make(map[string]float64)
    for token, price := range rawTokenPrices {
        tokenPrices[token] = price.(float64)
    }
    return tokenPrices
}

func calculateAverageLiquidityFromData(liquidityData []LiquidityData, startToken string) (*big.Float, error) {
    // Initialize total liquidity and count variables
    totalLiquidity := big.NewFloat(0)
    count := 0

    // Iterate over liquidity data to compute total liquidity and count
    for _, entry := range liquidityData {
        // Log details for each entry
        log.Printf("Processing liquidity entry: BaseToken=%s, TargetToken=%s, DstAmount=%s",
            entry.BaseToken, entry.TargetToken, entry.DstAmount.String())

        // Check if the BaseToken matches the startToken
        if strings.EqualFold(entry.BaseToken, startToken) {
            // Convert DstAmount from *big.Int to *big.Float
            liquidity := new(big.Float).SetInt(entry.DstAmount)

            // Accumulate total liquidity and increment count if liquidity is greater than zero
            if liquidity.Cmp(big.NewFloat(0)) > 0 {
                totalLiquidity.Add(totalLiquidity, liquidity)
                count++
            }
        }
    }

    // Calculate and return the average liquidity
    if count > 0 {
        return new(big.Float).Quo(totalLiquidity, big.NewFloat(float64(count))), nil
    }

    // Return an error if no liquidity data was available for the start token
    return big.NewFloat(0), fmt.Errorf("no liquidity data available for token: %s", startToken)
}

// Helper function to parse liquidity as *big.Float
func parseDstAmount(dstAmount string) (float64, error) {
    amount, ok := new(big.Float).SetString(dstAmount)
    if !ok {
        return 0, fmt.Errorf("invalid dstAmount: %s", dstAmount)
    }
    floatAmount, _ := amount.Float64()
    return floatAmount, nil
}


func adjustTradeSizeForGas(amount *big.Int, gasPrice *big.Int) (*big.Int, error) {
	estimatedGasCost := new(big.Int).Mul(gasPrice, big.NewInt(DefaultGasEstimate)) // Estimate: 800k gas units
	maxGasCostRatio := new(big.Int).Div(amount, big.NewInt(200))       // 0.5% of the amount

	if estimatedGasCost.Cmp(maxGasCostRatio) > 0 {
		log.Printf("Gas cost (%s) exceeds profit margin (%s). Adjusting trade size.", estimatedGasCost, maxGasCostRatio)
		return new(big.Int).Div(amount, big.NewInt(125)), nil // Scale down trade size by 20%
	}
	return amount, nil
}

func constructParams(route []string, amount *big.Int, signature string) (string, error) {
	swapDescription := map[string]interface{}{
		"srcToken":        route[0],
		"dstToken":        route[len(route)-1],
		"srcReceiver":     os.Getenv("EXECUTOR_ADDRESS"),
		"dstReceiver":     os.Getenv("CONTRACT_ADDRESS"),
		"amount":          amount.String(),
		"minReturnAmount": MINIMUM_PROFIT_THRESHOLD.String(),
		"flags":           "0x04",
	}

	params, err := json.Marshal(swapDescription)
	if err != nil {
		return "", fmt.Errorf("failed to construct params: %v", err)
	}

	return string(params), nil
}


func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}


// Decode transaction data (replace this ABI decoding logic with your contract's ABI)
func decodeTransactionData(data string, routerType string) (string, string, *big.Int, error) {
    // Lookup the ABI in the map
    parsedABI, exists := abis[routerType]
    if !exists {
        return "", "", nil, fmt.Errorf("unsupported router type: %s", routerType)
    }

    // Ensure data length is sufficient
    if len(data) < 10 {
        return "", "", nil, fmt.Errorf("invalid data length")
    }

    // Extract method signature and input data
    methodSig := common.FromHex(data[:10]) // First 4 bytes are the method signature
    inputData := common.FromHex(data)

    // Decode the transaction data using the ABI
    method, err := parsedABI.MethodById(methodSig)
    if err != nil {
        return "", "", nil, fmt.Errorf("failed to decode method ID: %v", err)
    }

    args := make(map[string]interface{})
    if err := method.Inputs.UnpackIntoMap(args, inputData[4:]); err != nil {
        return "", "", nil, fmt.Errorf("failed to unpack inputs: %v", err)
    }

    // Extract and validate `tokenIn`
    tokenIn, ok := args["tokenIn"].(common.Address)
    if !ok || !common.IsHexAddress(tokenIn.Hex()) {
        return "", "", nil, fmt.Errorf("invalid or missing tokenIn")
    }

    // Extract and validate `tokenOut`
    tokenOut, ok := args["tokenOut"].(common.Address)
    if !ok || !common.IsHexAddress(tokenOut.Hex()) {
        return "", "", nil, fmt.Errorf("invalid or missing tokenOut")
    }

    // Extract and validate `amountIn`
    amountIn, ok := args["amountIn"].(*big.Int)
    if !ok {
        return "", "", nil, fmt.Errorf("invalid or missing amountIn")
    }

    return tokenIn.Hex(), tokenOut.Hex(), amountIn, nil
}


// Process a transaction to identify arbitrage opportunities
func processTransaction(client *ethclient.Client, tx *types.Transaction, targetContracts map[string]bool) {
	// Validate the transaction target address
	toAddress := tx.To()
	if toAddress == nil {
		log.Println("Transaction does not have a target address. Skipping.")
		return
	}

	// Check if the transaction interacts with a relevant target contract
	if _, exists := targetContracts[toAddress.Hex()]; !exists {
		log.Printf("Transaction target address %s is not in the target contracts. Skipping.", toAddress.Hex())
		return
	}

	// Extract the input data from the transaction
	inputData := tx.Data()
	if len(inputData) < 4 {
		log.Println("Transaction data too short to decode. Skipping.")
		return
	}

	methodSig := inputData[:4] // First 4 bytes are the method signature

	// Attempt to decode using Uniswap ABI
	if method, err := uniswapABI.MethodById(methodSig); err == nil {
		args := make(map[string]interface{})
		if err := method.Inputs.UnpackIntoMap(args, inputData[4:]); err != nil {
			log.Printf("Failed to decode Uniswap transaction: %v", err)
			return
		}

		log.Printf("Decoded Uniswap transaction: Method=%s, Args=%v", method.Name, args)

		// Process Uniswap-specific transactions
		if err := processUniswapTransaction(method.Name, args); err != nil {
			log.Printf("Error processing Uniswap transaction: %v", err)
		}
		return
	}

	// Attempt to decode using SushiSwap ABI
	if method, err := sushiSwapABI.MethodById(methodSig); err == nil {
		args := make(map[string]interface{})
		if err := method.Inputs.UnpackIntoMap(args, inputData[4:]); err != nil {
			log.Printf("Failed to decode SushiSwap transaction: %v", err)
			return
		}

		log.Printf("Decoded SushiSwap transaction: Method=%s, Args=%v", method.Name, args)

		// Process SushiSwap-specific transactions
		if err := processSushiSwapTransaction(method.Name, args); err != nil {
			log.Printf("Error processing SushiSwap transaction: %v", err)
		}
		return
	}

	// Log any transaction that could not be decoded
	log.Printf("Unknown transaction targeting contract: %s", toAddress.Hex())
}

// Process Uniswap-specific transactions
func processUniswapTransaction(methodName string, args map[string]interface{}) error {
	switch methodName {
	case "exactInput":
		params, ok := args["params"].(map[string]interface{})
		if !ok {
			return fmt.Errorf("invalid params for exactInput")
		}

		path, ok := params["path"].([]byte)
		if !ok {
			return fmt.Errorf("invalid path for exactInput")
		}

		decodedPath, err := decodePath(path)
		if err != nil {
			return fmt.Errorf("failed to decode path: %v", err)
		}

		amountIn, ok := params["amountIn"].(*big.Int)
		if !ok {
			return fmt.Errorf("invalid amountIn for exactInput")
		}

		amountOutMinimum, ok := params["amountOutMinimum"].(*big.Int)
		if !ok {
			return fmt.Errorf("invalid amountOutMinimum for exactInput")
		}

		log.Printf("Uniswap exactInput: Path=%v, AmountIn=%s, AmountOutMin=%s",
			decodedPath, amountIn.String(), amountOutMinimum.String())

	case "exactInputSingle":
		params, ok := args["params"].(map[string]interface{})
		if !ok {
			return fmt.Errorf("invalid params for exactInputSingle")
		}

		tokenIn, ok := params["tokenIn"].(common.Address)
		if !ok {
			return fmt.Errorf("invalid tokenIn for exactInputSingle")
		}

		tokenOut, ok := params["tokenOut"].(common.Address)
		if !ok {
			return fmt.Errorf("invalid tokenOut for exactInputSingle")
		}

		amountIn, ok := params["amountIn"].(*big.Int)
		if !ok {
			return fmt.Errorf("invalid amountIn for exactInputSingle")
		}

		amountOutMinimum, ok := params["amountOutMinimum"].(*big.Int)
		if !ok {
			return fmt.Errorf("invalid amountOutMinimum for exactInputSingle")
		}

		log.Printf("Uniswap exactInputSingle: TokenIn=%s, TokenOut=%s, AmountIn=%s, AmountOutMin=%s",
			tokenIn.Hex(), tokenOut.Hex(), amountIn.String(), amountOutMinimum.String())

	default:
		log.Printf("Unhandled Uniswap method: %s", methodName)
		return fmt.Errorf("unhandled method: %s", methodName)
	}

	return nil
}


// Helper function to decode Uniswap V3 path
func decodePath(path []byte) ([]string, error) {
    const addressLength = 20
    if len(path)%addressLength != 0 {
        return nil, fmt.Errorf("invalid path length")
    }

    decodedPath := make([]string, 0, len(path)/addressLength)
    for i := 0; i < len(path); i += addressLength {
        token := common.BytesToAddress(path[i : i+addressLength])
        decodedPath = append(decodedPath, token.Hex())
    }
    return decodedPath, nil
}


// Process SushiSwap-specific transactions
func processSushiSwapTransaction(methodName string, args map[string]interface{}) error {
	switch methodName {
	case "swapExactTokensForTokens":
		amountIn, ok := args["amountIn"].(*big.Int)
		if !ok {
			return fmt.Errorf("invalid amountIn for swapExactTokensForTokens")
		}

		amountOutMin, ok := args["amountOutMin"].(*big.Int)
		if !ok {
			return fmt.Errorf("invalid amountOutMin for swapExactTokensForTokens")
		}

		path, ok := args["path"].([]common.Address)
		if !ok {
			return fmt.Errorf("invalid path for swapExactTokensForTokens")
		}

		decodedPath := decodePathSushi(path)
		log.Printf("SushiSwap swapExactTokensForTokens: AmountIn=%s, AmountOutMin=%s, Path=%v",
			amountIn.String(), amountOutMin.String(), decodedPath)

	case "swapTokensForExactTokens":
		amountOut, ok := args["amountOut"].(*big.Int)
		if !ok {
			return fmt.Errorf("invalid amountOut for swapTokensForExactTokens")
		}

		amountInMax, ok := args["amountInMax"].(*big.Int)
		if !ok {
			return fmt.Errorf("invalid amountInMax for swapTokensForExactTokens")
		}

		path, ok := args["path"].([]common.Address)
		if !ok {
			return fmt.Errorf("invalid path for swapTokensForExactTokens")
		}

		decodedPath := decodePathSushi(path)
		log.Printf("SushiSwap swapTokensForExactTokens: AmountOut=%s, AmountInMax=%s, Path=%v",
			amountOut.String(), amountInMax.String(), decodedPath)

	default:
		log.Printf("Unhandled SushiSwap method: %s", methodName)
		return fmt.Errorf("unhandled method: %s", methodName)
	}

	return nil
}

// Helper function to decode SushiSwap path
func decodePathSushi(path []common.Address) []string {
	decodedPath := []string{}
	for _, token := range path {
		decodedPath = append(decodedPath, token.Hex())
	}
	return decodedPath
}

func shutdownAll(ctx context.Context) {
	log.Println("Initiating shutdown sequence...")

	// Shutdown WebSocket server
	shutdownWebSocketServer()

	// Wait for context cancellation to ensure all components are stopped
        wg.Wait() // Wait for all tasks to finish
	<-ctx.Done()
	log.Println("All components shut down gracefully.")
}


// Monitor mempool for pending transactions
func monitorMempoolWithRetry(ctx context.Context, targetContracts map[string]bool, rpcURL string) error {
	wg.Add(1)
	defer wg.Done()

	log.Println("Starting mempool monitoring with retry and fallback mechanism...")

	for {
		select {
		case <-ctx.Done():
			log.Println("Mempool monitoring stopped due to context cancellation.")
			return nil
		default:
			// Try to monitor using WebSocket notifications
			err := monitorMempool(ctx, targetContracts, rpcURL)
			if err != nil {
				if isWebSocketNotSupportedError(err) {
					// Fallback to HTTP polling if WebSocket is not supported
					log.Println("WebSocket notifications not supported. Falling back to HTTP polling...")
					return monitorMempoolWithPolling(ctx, targetContracts, rpcURL)
				}
				log.Printf("Error in mempool monitoring: %v. Retrying...", err)
				time.Sleep(5 * time.Second) // Delay before retry
			}
		}
	}
}


func monitorMempool(ctx context.Context, targetContracts map[string]bool, rpcURL string) error {
	ch := make(chan string)

	// Connect to Ethereum client
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return fmt.Errorf("failed to connect to Ethereum client: %v", err)
	}
	defer client.Close()

	log.Println("Attempting to subscribe to mempool via WebSocket...")

	rpcClient, err := rpc.Dial(rpcURL)
	if err != nil {
		return fmt.Errorf("failed to connect to RPC client: %v", err)
	}

	// Subscribe to pending transactions
	sub, err := rpcClient.Subscribe(ctx, "newPendingTransactions", ch)
	if err != nil {
		log.Printf("WebSocket subscription failed: %v", err)
		return fmt.Errorf("notifications not supported: %v", err)
	}
	defer sub.Unsubscribe()

	log.Println("Successfully subscribed to newPendingTransactions.")

	for {
		select {
		case err := <-sub.Err():
			log.Printf("Subscription error: %v. Retrying subscription...", err)
			return err
		case txHash := <-ch:
			// Process the transaction
			tx, _, err := client.TransactionByHash(ctx, common.HexToHash(txHash))
			if err != nil {
				log.Printf("Failed to fetch transaction details for hash %s: %v", txHash, err)
				continue
			}
			go processTransaction(client, tx, targetContracts)
		case <-ctx.Done():
			log.Println("Stopping WebSocket subscription due to context cancellation.")
			return nil
		}
	}
}

func isWebSocketNotSupportedError(err error) bool {
	return strings.Contains(err.Error(), "notifications not supported")
}

func monitorMempoolWithPolling(ctx context.Context, targetContracts map[string]bool, rpcURL string) error {
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return fmt.Errorf("failed to connect to Ethereum client: %v", err)
	}
	defer client.Close()

	log.Println("Starting mempool monitoring using HTTP polling...")

	for {
		select {
		case <-ctx.Done():
			log.Println("Mempool monitoring stopped due to context cancellation.")
			return nil
		default:
			if err := pollPendingTransactions(ctx, client, targetContracts); err != nil {
				log.Printf("Error polling pending transactions: %v", err)
			}
			time.Sleep(5 * time.Second) // Delay between polling cycles
		}
	}
}

func pollPendingTransactions(ctx context.Context, client *ethclient.Client, targetContracts map[string]bool) error {
	// Fetch the latest block
	block, err := client.BlockByNumber(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to fetch latest block: %v", err)
	}

	// Iterate through all transactions in the block
	for _, tx := range block.Transactions() {
		go processTransaction(client, tx, targetContracts)
	}

	log.Printf("Processed %d transactions from block %s", len(block.Transactions()), block.Hash().Hex())
	return nil
}


func fetchCurrentGasPrice(payload map[string]interface{}) (*big.Float, error) {
    rawGasPrice, ok := payload["gasPrice"].(string)
    if !ok {
        return nil, fmt.Errorf("missing or invalid gas price in payload")
    }

    gasPrice := new(big.Float)
    if _, _, err := gasPrice.Parse(rawGasPrice, 10); err != nil {
        return nil, fmt.Errorf("failed to parse gas price: %v", err)
    }

    return gasPrice, nil
}


func approveTokensNode(route []string, amount *big.Int) error {
	apiURL := os.Getenv("NODE_API_URL") + "/approve"
	payload := map[string]interface{}{
		"tokens": route,
		"amount": amount.String(),
	}

	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to create payload: %v", err)
	}

	// Retry logic with exponential backoff
	const maxRetries = 3
	backoff := time.Second

	for i := 1; i <= maxRetries; i++ {
		resp, err := http.Post(apiURL, "application/json", strings.NewReader(string(jsonPayload)))
		if err == nil && resp.StatusCode == http.StatusOK {
			defer resp.Body.Close()
			log.Println("Token approval completed successfully via Node.js API.")
			return nil
		}

		if err != nil {
			log.Printf("HTTP request failed (attempt %d/%d): %v", i, maxRetries, err)
		} else {
			defer resp.Body.Close()
			body, _ := ioutil.ReadAll(resp.Body)
			log.Printf("Non-200 response: %d, Body: %s", resp.StatusCode, string(body))
		}

		// Apply backoff before the next retry
		log.Printf("Retrying in %v... (%d/%d)", backoff, i, maxRetries)
		time.Sleep(backoff)
		backoff *= 2
	}

	return fmt.Errorf("token approval API failed after %d attempts", maxRetries)
}

func notifyNode(eventType, message string) {
	apiURL := os.Getenv("NODE_API_URL") + "/notify"
	payload := map[string]interface{}{
		"event":   eventType,
		"message": message,
	}

	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		log.Printf("Failed to create notification payload: %v", err)
		return
	}

	// Retry logic with exponential backoff
	const maxRetries = 3
	backoff := time.Second

	for i := 1; i <= maxRetries; i++ {
		resp, err := http.Post(apiURL, "application/json", strings.NewReader(string(jsonPayload)))
		if err == nil && resp.StatusCode == http.StatusOK {
			defer resp.Body.Close()
			log.Println("Notification sent successfully.")
			return
		}

		if err != nil {
			log.Printf("HTTP request failed (attempt %d/%d): %v", i, maxRetries, err)
		} else {
			defer resp.Body.Close()
			body, _ := ioutil.ReadAll(resp.Body)
			log.Printf("Non-200 response: %d, Body: %s", resp.StatusCode, string(body))
		}

		// Apply backoff before the next retry
		log.Printf("Retrying in %v... (%d/%d)", backoff, i, maxRetries)
		time.Sleep(backoff)
		backoff *= 2
	}

	log.Printf("Failed to notify Node.js after %d attempts", maxRetries)
}

func estimateGas(route []string, CAPITAL *big.Int) (*big.Int, error) {
	client, err := ethclient.Dial(os.Getenv("RPC_URL"))
	if err != nil {
		return nil, fmt.Errorf("failed to connect to Ethereum client: %v", err)
	}

	// Construct transaction calldata
	params, err := constructParams(route, CAPITAL, "")
	if err != nil {
		return nil, fmt.Errorf("failed to construct transaction parameters: %v", err)
	}
         contractAddress := common.HexToAddress(os.Getenv("CONTRACT_ADDRESS"))
	// Build call message
	callMsg := ethereum.CallMsg{
		From: common.HexToAddress(os.Getenv("WALLET_ADDRESS")),
		To:   &contractAddress,
		Data: common.FromHex(params),
	}

	// Estimate gas
	gasEstimate, err := client.EstimateGas(context.Background(), callMsg)
	if err != nil {
		log.Printf("Error estimating gas: %v. Returning fallback estimate.", err)
		return big.NewInt(DefaultGasEstimate), nil // Fallback gas estimate
	}

	log.Printf("Gas estimate: %d", gasEstimate)
	return big.NewInt(int64(gasEstimate)), nil
}

func fetchPermit2Signature(token, spender, amount string) (*PermitDetails, error) {
	// Fetch API URL from environment variables
	apiBaseURL := os.Getenv("NODE_API_URL")
	if apiBaseURL == "" {
		return nil, fmt.Errorf("NODE_API_URL environment variable is not set")
	}

	// Construct the full API endpoint
	url := fmt.Sprintf("%s/generate-permit2-signature", apiBaseURL)

	// Prepare the request body
	requestBody, err := json.Marshal(map[string]string{
		"token":   token,
		"spender": spender,
		"amount":  amount,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create request body: %v", err)
	}

	// Retry logic with exponential backoff
	const maxRetries = 3
	backoff := time.Second

	for i := 1; i <= maxRetries; i++ {
		resp, err := http.Post(url, "application/json", bytes.NewBuffer(requestBody))
		if err != nil {
			log.Printf("HTTP request failed (attempt %d/%d): %v", i, maxRetries, err)
		} else {
			defer resp.Body.Close()

			// Check the HTTP response status
			if resp.StatusCode == http.StatusOK {
				// Decode the JSON response
				var permitDetails PermitDetails
				if err := json.NewDecoder(resp.Body).Decode(&permitDetails); err != nil {
					return nil, fmt.Errorf("failed to decode response: %v", err)
				}
				return &permitDetails, nil
			}

			// Log non-200 responses
			bodyBytes, _ := ioutil.ReadAll(resp.Body)
			log.Printf("Non-200 response: %d, Body: %s", resp.StatusCode, string(bodyBytes))
		}

		// Apply backoff before the next retry
		log.Printf("Retrying in %v... (%d/%d)", backoff, i, maxRetries)
		time.Sleep(backoff)
		backoff *= 2
	}

	return nil, fmt.Errorf("failed to fetch Permit2 signature after %d attempts", maxRetries)
}



// WebSocket handler
func wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}

	client := &WebSocketClient{
		Conn: conn, 
		RateLimiter: rateLimiter, 
		Disconnected: make(chan bool),
	}
	client.Context, client.CancelFunc = context.WithCancel(context.Background())

	clientsMutex.Lock()
	wsClients[client] = true
	clientsMutex.Unlock()

	go handleMessages(client)
}

func generateSessionID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

func logMemoryUsage() {
    var memStats runtime.MemStats
    runtime.ReadMemStats(&memStats)

    log.Printf("Memory Usage: Alloc = %v KB, TotalAlloc = %v KB, Sys = %v KB, NumGC = %v",
        memStats.Alloc/1024, memStats.TotalAlloc/1024, memStats.Sys/1024, memStats.NumGC)
}

func monitorClientConnection(client *WebSocketClient) {
	select {
	case <-client.Disconnected:
		log.Println("Client disconnected. Cleaning up resources...")
	case <-client.Context.Done():
		log.Println("Context canceled. Cleaning up resources...")
	}

	// Cleanup resources
	clientsMutex.Lock()
        delete(wsClients, client)
	clientsMutex.Unlock()

	client.RateLimiter.Stop()
	client.Conn.Close()
	client.CancelFunc() // Cancel the context
}

func handleClientMessages(client *WebSocketClient) {
	defer func() {
		// Signal disconnection and clean up
		client.Disconnected <- true
	}()

	for {
		select {
		case <-client.Context.Done():
			log.Println("Stopping message handler for disconnected client.")
			return
		default:
			// Read and handle WebSocket messages
			_, message, err := client.Conn.ReadMessage()
			if err != nil {
				log.Printf("Error reading message from client: %v", err)
				client.Disconnected <- true
				return
			}

			if !client.RateLimiter.Allow() {
				log.Println("Rate limit exceeded. Dropping message.")
				continue
			}

			// Handle valid messages (e.g., broadcast)
			broadcastChan <- []byte(message) // Correct type for byte array.
		}
	}
}

func shutdownWebSocketServer() {
    clientsMutex.Lock()
    defer clientsMutex.Unlock()

    for client := range wsClients {
        client.Conn.WriteMessage(websocket.CloseMessage, []byte{})
        client.Conn.Close()
        delete(wsClients, client)
    }
    log.Println("WebSocket server shut down.")
}


func monitorSystemHealth() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		clientsMutex.Lock()
		activeClients := len(wsClients)
		clientsMutex.Unlock()

		var memStats runtime.MemStats
		runtime.ReadMemStats(&memStats)

		log.Printf("Active Clients: %d | Goroutines: %d | Memory Usage: Alloc=%vKB TotalAlloc=%vKB Sys=%vKB",
			activeClients, runtime.NumGoroutine(), memStats.Alloc/1024, memStats.TotalAlloc/1024, memStats.Sys/1024)
	}
}

func cleanupInactiveClients() {
    clientsMutex.Lock()
    defer clientsMutex.Unlock()

    for client := range wsClients {
        if client.Context.Err() != nil { // Context canceled
            client.Conn.Close()
            delete(wsClients, client)

        }
    }
}

// Handle messages from a WebSocket client
func handleMessages(client *WebSocketClient) {
	defer func() {
		client.Disconnected <- true
		clientsMutex.Lock()
		delete(wsClients, client)
		clientsMutex.Unlock()
		client.RateLimiter.Stop()
		client.Conn.Close()
		log.Println("Client disconnected.")
	}()

	for {
		_, msg, err := client.Conn.ReadMessage()
		if err != nil {
			log.Printf("WebSocket read error: %v", err)
			return
		}

		if !client.RateLimiter.Allow() {
			log.Println("Rate limit exceeded, dropping message.")
			continue
		}

		broadcastChan <- msg
	}
}


// Broadcast messages to all WebSocket clients
func broadcastMessages() {
	for msg := range broadcastChan {
		clientsMutex.Lock() // Lock the clients map for safe access
		for client := range wsClients {
			// Attempt to write the message to the WebSocket connection
			if err := client.Conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				log.Printf("Error broadcasting message: %v", err)

				// Close the connection and remove the client from the map
				client.Conn.Close()
				delete(wsClients, client)
			}
		}
		clientsMutex.Unlock() // Unlock after iterating
	}
}

// Broadcast opportunities to WebSocket clients
func wsBroadcastManager() {
    for opportunity := range wsBroadcast {
        data, err := json.Marshal(opportunity)
        if err != nil {
            log.Printf("Error marshaling broadcast data: %v", err)
            continue
        }

        clientsMutex.Lock() // Lock to safely iterate over wsClients
        for client := range wsClients {
            wsConn := client.Conn
            func(wsConn *websocket.Conn) {
                defer func() {
                    if r := recover(); r != nil {
                        log.Printf("Recovered from panic while sending WebSocket message: %v", r)
                        wsConn.Close()
                        clientsMutex.Lock()
                        delete(wsClients, client)
                        clientsMutex.Unlock()
                    }
                }()

                // Attempt to send the message to the WebSocket client
                if err := wsConn.WriteMessage(websocket.TextMessage, data); err != nil {
                    log.Printf("WebSocket send error: %v", err)
                    wsConn.Close()
                    clientsMutex.Lock()
                    delete(wsClients, client)
                    clientsMutex.Unlock()
                }
            }(wsConn)
        }
        clientsMutex.Unlock()
    }
}

func logRequests(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        log.Printf("Incoming request: %s %s %s", r.Method, r.URL.Path, r.Proto)
        next.ServeHTTP(w, r)
    })
}

func enableCORS(next http.HandlerFunc) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Access-Control-Allow-Origin", "*")
        w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

        if r.Method == http.MethodOptions {
            w.WriteHeader(http.StatusOK)
            return
        }
        next(w, r)
    }
}


func notifyNodeOfRoutes(routes []Route) error {
    if len(routes) == 0 {
        log.Println("No profitable routes to notify.")
        return nil
    }

    // Construct the payload
    payload := map[string]interface{}{
        "routes": routes,
    }

    // Convert payload to JSON
    jsonData, err := json.Marshal(payload)
    if err != nil {
        return fmt.Errorf("failed to marshal routes payload: %v", err)
    }

    // Send to Node.js script
    nodeURL := os.Getenv("NODE_URL") // URL of the Node.js script
    if nodeURL == "" {
        return fmt.Errorf("NODE_URL environment variable is not set")
    }

    resp, err := http.Post(nodeURL, "application/json", bytes.NewBuffer(jsonData))
    if err != nil {
        return fmt.Errorf("failed to send routes to Node.js script: %v", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("received non-OK response from Node.js script: %d", resp.StatusCode)
    }

    log.Println("Successfully notified Node.js script of profitable routes.")
    return nil
}

// Main function
func main() {
    // Validate required environment variables
    requiredVars := []string{"RPC_URL", "NODE_API_URL", "PRIVATE_KEY", "WALLET_ADDRESS"}
    if err := validateEnvVars(requiredVars); err != nil {
        log.Fatalf("Environment variables validation failed: %v", err)
    }

    // Context with cancel function for graceful shutdown
    ctx, cancelFunc := context.WithCancel(context.Background())
    defer cancelFunc()

    // Handle OS signals for graceful shutdown
    go func() {
        c := make(chan os.Signal, 1)
        signal.Notify(c, os.Interrupt, syscall.SIGTERM)
        <-c
        log.Println("Shutdown signal received, cleaning up resources...")
        cancelFunc()
        shutdownWebSocketServer()
    }()

    // Health endpoint
    http.HandleFunc("/health", healthHandler)
    http.Handle("/process-market-data", logRequests(enableCORS(generateRoutesHTTPHandler)))
    http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        log.Printf("Received %s request for %s", r.Method, r.URL.Path)
        http.NotFound(w, r)
    })

    // Start the HTTP server
    port := ":8080" // Adjust as needed
    log.Printf("Server running on port %s...", port)
    if err := http.ListenAndServe(port, nil); err != nil {
        log.Fatalf("Failed to start server: %v", err)
    }

    // Define target contracts for mempool monitoring
    targetContracts := map[string]bool{
        "0xE592427A0AEce92De3Edee1F18E0157C05861564": true, // Uniswap V3
        "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F": true, // SushiSwap
    }

    // Start monitoring the mempool
    go func() {
        if err := monitorMempoolWithRetry(ctx, targetContracts, os.Getenv("RPC_URL")); err != nil {
            log.Printf("Mempool monitoring terminated: %v", err)
            cancelFunc()
        }
    }()

    // Monitor system health periodically
    go monitorSystemHealth()

    // Wait for shutdown
    <-ctx.Done()
    log.Println("System shutdown complete.")
}


// Helper function to validate token address
func isValidTokenAddress(address string) bool {
	// Replace with your token address validation logic (e.g., regex or lookup)
	return len(address) == 42 && address[:2] == "0x"
}
