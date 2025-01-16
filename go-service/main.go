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

var (
	uniswapABI    abi.ABI
	sushiSwapABI  abi.ABI
)

var apiRateLimiter = NewRateLimiter(5, time.Second) // Allow 5 API calls per second
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
}

type MarketData struct {
        ChainID         int64                      `json:"chainId"`
        StartToken      string                     `json:"startToken"`
        StartAmount     string                     `json:"startAmount"` // Use string for large numbers
        MaxHops         int                        `json:"maxHops"`
        ProfitThreshold string                     `json:"profitThreshold"` // Use string for large numbers
        TokenPrices     map[string]float64        `json:"tokenPrices"`
        Liquidity       []LiquidityData           `json:"liquidity"`
    }

type EdgeWeight struct {
	Weight    *big.Float // Weight of the edge (e.g., price or inverse liquidity)
	Liquidity *big.Float // Liquidity available for the edge
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
    big.Int
}


type LiquidityData struct {
    BaseToken  string
    TargetToken string
    DstAmount  *big.Int
    Gas        uint64
    Paths      [][][]PathSegment
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

// type TokenPair struct {
// 	SrcToken string `json:"srcToken"`
// 	DstToken string `json:"dstToken"`
// }

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


// ComputeOptimalRoute finds the optimal route using Dijkstra's algorithm
func ComputeOptimalRoute(graph *WeightedGraph, startToken, endToken string, useAStar bool) ([]string, *big.Float, error) {
    // Check if start and end tokens exist in the graph
    if _, exists := graph.AdjacencyList[startToken]; !exists {
        return nil, nil, fmt.Errorf("start token %s not in graph", startToken)
    }
    if _, exists := graph.AdjacencyList[endToken]; !exists {
        return nil, nil, fmt.Errorf("end token %s not in graph", endToken)
    }

    // Initialize distances and previous map
    distances := make(map[string]*big.Float)
    previous := make(map[string]string)

    for token := range graph.AdjacencyList {
        distances[token] = big.NewFloat(math.Inf(1)) // Set all distances to infinity
    }
    distances[startToken] = big.NewFloat(0) // Distance to the startToken is 0

    // Priority queue for the algorithm
    pq := make(PriorityQueue, 0)
    heap.Init(&pq)
    heap.Push(&pq, &Node{Token: startToken, Priority: 0})

    // Map to track visited nodes
    visited := make(map[string]bool)

    // Define heuristic function for A* (can be replaced with domain-specific logic)
    heuristic := func(token string) *big.Float {
        if token == endToken {
            return big.NewFloat(0) // No distance if it's the end token
        }
        // Example heuristic: constant cost (can be replaced with real estimates)
        return big.NewFloat(1.0)
    }

    // Main loop for Dijkstra/A* algorithm
    for pq.Len() > 0 {
        current := heap.Pop(&pq).(*Node)
        currentToken := current.Token

        if visited[currentToken] {
            continue
        }
        visited[currentToken] = true

        // If the endToken is reached, reconstruct and return the path
        if currentToken == endToken {
            path := []string{}
            for token := endToken; token != ""; token = previous[token] {
                path = append([]string{token}, path...)
            }
            return path, distances[endToken], nil
        }

        // Process all neighbors of the current token
        for neighbor, edge := range graph.AdjacencyList[currentToken] {
            // Skip visited neighbors or low-liquidity edges
            if visited[neighbor] || edge.Liquidity.Cmp(big.NewFloat(1e-6)) < 0 {
                continue
            }

            // Relax the edge
            tentativeDistance := new(big.Float).Add(distances[currentToken], edge.Weight)
            if tentativeDistance.Cmp(distances[neighbor]) < 0 {
                distances[neighbor] = tentativeDistance
                previous[neighbor] = currentToken

                // Calculate priority for the neighbor
                priority := new(big.Float).Set(tentativeDistance)
                if useAStar {
                    priority = new(big.Float).Add(tentativeDistance, heuristic(neighbor))
                }

                // Push the neighbor into the priority queue
                priorityFloat, _ := priority.Float64()
                heap.Push(&pq, &Node{Token: neighbor, Priority: priorityFloat})
            }
        }
    }

    // If no path was found
    return nil, nil, fmt.Errorf("no path found from %s to %s", startToken, endToken)
}

// calculateTotalGasCost calculates the total gas cost for a transaction.
func calculateTotalGasCost(gasPrice *big.Int, gasLimit uint64) *big.Int {
    // Ensure gas price and limit are valid
    if gasPrice == nil || gasPrice.Cmp(big.NewInt(0)) <= 0 {
        log.Println("Invalid or nil gas price provided. Defaulting to 50 Gwei.")
        gasPrice = big.NewInt(50 * 1e9) // Default to 50 Gwei
    }

    if gasLimit == 0 {
        log.Println("Invalid gas limit provided. Defaulting to 800,000 units.")
        gasLimit = DefaultGasEstimate // Default gas limit
    }

    // Calculate total gas cost: gas price * gas limit
    totalGasCost := new(big.Int).Mul(gasPrice, big.NewInt(int64(gasLimit)))

    // Log for debugging
    log.Printf("Calculated total gas cost: %s wei (Gas Price: %s wei, Gas Limit: %d)", totalGasCost.String(), gasPrice.String(), gasLimit)

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

// EvaluateRouteProfit evaluates the profitability of a given route
func evaluateRouteProfit(route []string, tokenPrices map[string]TokenPrice, gasPrice *big.Float) (*big.Int, error) {
    if len(route) < 2 {
        return nil, fmt.Errorf("invalid route, must contain at least two tokens")
    }

    amountIn := new(big.Int).Set(CAPITAL)
    totalGasCost := new(big.Int)

    gasPriceInt := new(big.Int)
    gasPrice.Int(gasPriceInt)

    for i := 0; i < len(route)-1; i++ {
        fromToken := route[i]
        toToken := route[i+1]

        fromData, ok := tokenPrices[fromToken]
        if !ok {
            return nil, fmt.Errorf("missing price data for token: %s", fromToken)
        }
        toData, ok := tokenPrices[toToken]
        if !ok {
            return nil, fmt.Errorf("missing price data for token: %s", toToken)
        }

        // Adjust amount for slippage and compute trade amount
        adjustedAmountFloat, err := adjustForSlippage(new(big.Float).SetInt(amountIn), fromData.Liquidity)
        if err != nil {
            return nil, fmt.Errorf("slippage adjustment failed: %v", err)
        }

        adjustedAmount := new(big.Int)
        adjustedAmountFloat.Int(adjustedAmount)

        priceRatio := new(big.Float).Quo(toData.Price, fromData.Price)
        tradeAmount := new(big.Float).Mul(new(big.Float).SetInt(adjustedAmount), priceRatio)

        amountIn = new(big.Int)
        tradeAmount.Int(amountIn)

        hopGasCost := calculateTotalGasCost(gasPriceInt, DefaultGasEstimate)
        totalGasCost.Add(totalGasCost, hopGasCost)

        if amountIn.Cmp(big.NewInt(0)) <= 0 {
            return nil, fmt.Errorf("trade resulted in zero or negative amount")
        }
    }

    netProfit := new(big.Int).Sub(new(big.Int).Sub(amountIn, CAPITAL), totalGasCost)
    if netProfit.Cmp(MINIMUM_PROFIT_THRESHOLD) < 0 {
        return nil, nil
    }

    return netProfit, nil
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

// Dynamically calculate the profit threshold
func calculateDynamicProfitThreshold(gasPrice *big.Float) (*big.Int, error) {
	gasCost := new(big.Float).Mul(gasPrice, big.NewFloat(DefaultGasEstimate))
	flashLoanFee := new(big.Float).Mul(new(big.Float).SetInt(CAPITAL), FLASHLOAN_FEE_RATE)
	totalCost := new(big.Float).Add(gasCost, flashLoanFee)

	profitThreshold := new(big.Float).Add(totalCost, new(big.Float).SetInt(MINIMUM_PROFIT_THRESHOLD))
	result := new(big.Int)
	profitThreshold.Int(result) // Convert *big.Float to *big.Int

	log.Printf("Dynamic profit threshold: %s", result.String())
	return result, nil
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

// REST API Handler for Route Generation
func generateRoutesHTTPHandler(w http.ResponseWriter, r *http.Request) {
    log.Printf("Incoming request: %s %s", r.Method, r.URL.Path)

    if r.Method == http.MethodGet {
        log.Println("Ignoring health check GET request")
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("Health check acknowledged"))
        return
    }

    if r.Method != http.MethodPost {
        log.Printf("Invalid request method: %s", r.Method)
        http.Error(w, "Invalid request method. Only POST is allowed.", http.StatusMethodNotAllowed)
        return
    }

    log.Println("Processing POST request to /process-market-data")

    var marketData MarketData
    if err := json.NewDecoder(r.Body).Decode(&marketData); err != nil {
        log.Printf("Failed to decode request body: %v", err)
        http.Error(w, "Invalid request body. Please send valid JSON.", http.StatusBadRequest)
        return
    }

    if marketData.StartToken == "" || marketData.StartAmount == "" || len(marketData.Liquidity) == 0 {
        log.Println("Missing required fields in the request body")
        http.Error(w, "Missing required fields: 'startToken', 'startAmount', or 'liquidity'", http.StatusBadRequest)
        return
    }

    startAmount := new(big.Int)
    if _, ok := startAmount.SetString(marketData.StartAmount, 10); !ok {
        log.Printf("Invalid startAmount value: %s", marketData.StartAmount)
        http.Error(w, "Invalid 'startAmount' value. Must be a valid integer string.", http.StatusBadRequest)
        return
    }

    profitThreshold := new(big.Int)
    if _, ok := profitThreshold.SetString(marketData.ProfitThreshold, 10); !ok {
        log.Printf("Invalid profitThreshold value: %s", marketData.ProfitThreshold)
        http.Error(w, "Invalid 'profitThreshold' value. Must be a valid integer string.", http.StatusBadRequest)
        return
    }

    // Call generateRoutes with MarketData directly
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

func processAndValidateLiquidity(
    liquidity []LiquidityData,
    tokenPrices map[string]TokenPrice,
    minDstAmount float64,
) []LiquidityData {
    var validLiquidity []LiquidityData

    for _, data := range liquidity {
        var validPaths [][][]PathSegment

        for _, path := range data.Paths {
            var validSegments []PathSegment

            for _, segments := range path {
                for _, segment := range segments {
                    // Validate fields of each PathSegment
                    if segment.Name == "" || segment.Part <= 0 ||
                        !common.IsHexAddress(segment.FromTokenAddress) ||
                        !common.IsHexAddress(segment.ToTokenAddress) {
                        log.Printf("Invalid path segment skipped: %+v", segment)
                        continue
                    }

                    // Check token price availability for the target token
                    targetTokenPrice, priceOk := tokenPrices[segment.ToTokenAddress]
                    if !priceOk {
                        log.Printf("Skipping path segment, missing price for token: %s", segment.ToTokenAddress)
                        continue
                    }

                    // Calculate destination amount in USD
                    dstAmountInUSD := new(big.Float).Mul(targetTokenPrice.Price, new(big.Float).SetFloat64(segment.Part))
                    if dstAmountInUSD.Cmp(big.NewFloat(minDstAmount)) < 0 {
                        log.Printf("Path segment filtered due to insufficient profitability: TargetToken=%s, DstAmount=%.2f USD",
                            segment.ToTokenAddress, dstAmountInUSD)
                        continue
                    }

                    validSegments = append(validSegments, segment)
                }
            }

            if len(validSegments) > 0 {
                validPaths = append(validPaths, [][]PathSegment{validSegments})
            }
        }

        if len(validPaths) > 0 {
            validLiquidity = append(validLiquidity, LiquidityData{
                BaseToken:   data.BaseToken,
                TargetToken: data.TargetToken,
                DstAmount:   data.DstAmount,
                Gas:         data.Gas,
                Paths:       validPaths,
            })
        }
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

        gas := uint64(0)
        if gasFloat, ok := liquidityItem["gas"].(float64); ok {
            gas = uint64(gasFloat)
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
            Gas:         gas,
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

func generateRoutes(marketData MarketData) ([]Route, error) {
    // Validate inputs
    if !common.IsHexAddress(marketData.StartToken) {
        return nil, fmt.Errorf("invalid start token address: %s", marketData.StartToken)
    }

    startAmount := new(big.Int)
    if _, ok := startAmount.SetString(marketData.StartAmount, 10); !ok || startAmount.Cmp(big.NewInt(0)) <= 0 {
        return nil, fmt.Errorf("invalid or non-positive startAmount: %s", marketData.StartAmount)
    }

    profitThreshold := new(big.Int)
    if _, ok := profitThreshold.SetString(marketData.ProfitThreshold, 10); !ok || profitThreshold.Cmp(big.NewInt(0)) <= 0 {
        return nil, fmt.Errorf("invalid or non-positive profitThreshold: %s", marketData.ProfitThreshold)
    }

    // Extract stable token addresses
    stableTokenAddresses := extractStableTokens(marketData.Liquidity)

    // Calculate average liquidity
    averageLiquidity, err := calculateAverageLiquidityFromData(marketData.Liquidity, marketData.StartToken)
    if err != nil {
        return nil, fmt.Errorf("failed to calculate average liquidity: %v", err)
    }
    log.Printf("Average liquidity calculated: %f", averageLiquidity)

    // Extract gas price and convert token prices
    gasPrice := extractGasPriceFromLiquidity(marketData.Liquidity)
    tokenPrices := convertTokenPricesToMap(marketData.TokenPrices, marketData.Liquidity)

    // Build and process the graph
    graph, profitableRoutes, err := buildAndProcessGraph(marketData.Liquidity, tokenPrices, gasPrice)
    if err != nil {
        return nil, fmt.Errorf("failed to build and process graph: %v", err)
    }
    log.Printf("Graph successfully built with profitable routes: %d", len(profitableRoutes))

    var finalRoutes []Route
    var mu sync.Mutex
    var wg sync.WaitGroup

    for _, endToken := range stableTokenAddresses {
        if strings.EqualFold(endToken, marketData.StartToken) {
            continue
        }

        wg.Add(1)
        go func(endToken string) {
            defer wg.Done()

            // Compute optimal route
            path, cost, err := ComputeOptimalRoute(graph, marketData.StartToken, endToken, false)
            if err != nil || len(path) <= 1 || !strings.EqualFold(path[0], marketData.StartToken) {
                log.Printf("Skipping invalid or unprofitable path: %v", path)
                return
            }

            costInt := new(big.Int)
            cost.Int(costInt)

            // Calculate profit, factoring in fees
            gasFee := calculateTotalGasCost(gasPrice, DefaultGasEstimate)
            totalCost := new(big.Int).Add(costInt, gasFee)
            profit := new(big.Int).Sub(startAmount, totalCost)

            if profit.Cmp(profitThreshold) > 0 {
                mu.Lock()
                finalRoutes = append(finalRoutes, Route{
                    Path:   path,
                    Profit: profit,
                })
                mu.Unlock()
                log.Printf("Profitable route found: %s with profit: %s", strings.Join(path, " ➡️ "), profit.String())
            }
        }(endToken)
    }

    wg.Wait()

    // Notify Node.js script
    if err := notifyNodeOfRoutes(finalRoutes); err != nil {
        log.Printf("Failed to notify Node.js script of routes: %v", err)
    }

    log.Printf("Generated %d profitable routes.", len(finalRoutes))
    return finalRoutes, nil
}

func extractGasPriceFromLiquidity(liquidityData []LiquidityData) *big.Float {
    totalGas := big.NewInt(0)
    count := 0

    for _, entry := range liquidityData {
        totalGas.Add(totalGas, new(big.Int).SetUint64(entry.Gas))
        count++
    }

    if count == 0 {
        return big.NewFloat(1.0) // Default gas price if no data is available
    }

    avgGas := new(big.Float).Quo(new(big.Float).SetInt(totalGas), big.NewFloat(float64(count)))
    return avgGas
}


func convertTokenPricesToMap(
    rawPrices map[string]float64,
    liquidityData []LiquidityData,
) map[string]TokenPrice {
    tokenPrices := make(map[string]TokenPrice)

    for _, entry := range liquidityData {
        if entry.DstAmount == nil || entry.DstAmount.Cmp(big.NewInt(0)) <= 0 {
            log.Printf("Skipping liquidity entry due to invalid DstAmount: %+v", entry)
            continue
        }

        // Parse price for BaseToken
        srcPrice, srcExists := rawPrices[entry.BaseToken]
        if !srcExists || srcPrice <= 0 {
            log.Printf("Skipping BaseToken %s due to missing or invalid price", entry.BaseToken)
            continue
        }

        // Parse price for TargetToken
        dstPrice, dstExists := rawPrices[entry.TargetToken]
        if !dstExists || dstPrice <= 0 {
            log.Printf("Skipping TargetToken %s due to missing or invalid price", entry.TargetToken)
            continue
        }

        // Convert DstAmount (liquidity) from *big.Int to *big.Float
        liquidity := new(big.Float).SetInt(entry.DstAmount)

        // Add token price and liquidity information
        tokenPrices[entry.BaseToken] = TokenPrice{
            Price:     new(big.Float).SetFloat64(srcPrice),
            Liquidity: liquidity,
        }
    }

    log.Printf("Converted token prices map with %d entries.", len(tokenPrices))
    return tokenPrices
}


// Converts [][]map[string]interface{} back to []LiquidityData
func convertToLiquidityData(tokenPairs []TokenPair) []LiquidityData {
    var liquidityData []LiquidityData

    for _, pair := range tokenPairs {
        // Construct individual path segment
        segment := PathSegment{
            Name:             fmt.Sprintf("%s -> %s", pair.SrcToken, pair.DstToken),
            Part:             1.0, // Assume 100% allocation for now
            FromTokenAddress: pair.SrcToken,
            ToTokenAddress:   pair.DstToken,
        }

        // Wrap the segment in [][]PathSegment, and then wrap that in [][][]PathSegment
        paths := [][][]PathSegment{
            {
                {segment}, // Wrap each segment in the required nesting
            },
        }

        // Append the constructed LiquidityData
        liquidityData = append(liquidityData, LiquidityData{
            BaseToken:   pair.SrcToken,
            TargetToken: pair.DstToken,
            DstAmount:   new(big.Int), // Default value, adjust as needed
            Gas:         21000,           // Default gas, adjust based on real data
            Paths:       paths,           // Set paths with proper structure
        })
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


func filterRoutes(routes []Route, chainID int64, startToken string, startAmount *big.Int, maxHops int, profitThreshold *big.Int) ([]Route, error) {
	var filtered []Route

	for _, route := range routes {
		// Check chain ID
		if route.ChainID != chainID {
			continue
		}

		// Check start token
		if strings.ToLower(route.StartToken) != strings.ToLower(startToken) {
			continue
		}

		// Check start amount
		if route.StartAmount.Cmp(startAmount) < 0 {
			continue
		}

		// Check max hops
		if route.Hops > maxHops {
			continue
		}

		// Check profit threshold
		if route.Profit.Cmp(profitThreshold) < 0 {
			continue
		}

		// Add to filtered routes
		filtered = append(filtered, route)
	}

	return filtered, nil
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

func filterValidAddresses(tokens []StableToken) []string {
	var addresses []string
	for _, token := range tokens {
		if common.IsHexAddress(token.Address) {
			addresses = append(addresses, token.Address)
		}
	}
	return addresses
}

func buildAndProcessGraph(liquidityData []LiquidityData, tokenPrices map[string]TokenPrice, gasPrice *big.Float) (*WeightedGraph, []Route, error) {
    // Convert LiquidityData to TokenPair with weights
    tokenPairs := convertToTokenPairsWithWeights(liquidityData)

    // Call BuildGraph to construct the graph
    graph, err := BuildGraph(tokenPairs)
    if err != nil {
        log.Printf("Error building graph: %v", err)
        return nil, nil, err
    }

    // Evaluate each route in the graph for profitability
    profitableRoutes := []Route{}
    for srcToken, dstMap := range graph.AdjacencyList {
        for dstToken := range dstMap {
            route := []string{srcToken, dstToken}
            profit, err := evaluateRouteProfit(route, tokenPrices, gasPrice)
            if err != nil {
                log.Printf("Error evaluating route: %v", err)
                continue
            }

            if profit != nil {
                profitableRoutes = append(profitableRoutes, Route{
                    Path:   route,
                    Profit: profit,
                })
                log.Printf("Profitable route found: %v with profit: %s", route, profit.String())
            }
        }
    }

    if len(profitableRoutes) == 0 {
        log.Println("No profitable routes found.")
    } else {
        log.Printf("Generated %d profitable routes.", len(profitableRoutes))
    }

    return graph, profitableRoutes, nil
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

        // Append token pair with calculated weight
        tokenPairs = append(tokenPairs, TokenPair{
            SrcToken: entry.BaseToken,
            DstToken: entry.TargetToken,
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

func BuildGraph(tokenPairs []TokenPair) (*WeightedGraph, error) {
    // Initialize the graph structure
    graph := &WeightedGraph{AdjacencyList: make(map[string]map[string]EdgeWeight)}
    var wg sync.WaitGroup
    edgeChan := make(chan struct {
        SrcToken   string
        DstToken   string
        EdgeWeight EdgeWeight
    }, len(tokenPairs))

    // Process each token pair concurrently
    for _, pair := range tokenPairs {
        wg.Add(1)
        go func(pair TokenPair) {
            defer wg.Done()

            // Convert pair.Weight to *big.Float
            weight := new(big.Float).SetFloat64(pair.Weight)

            // Initialize edgeWeight with proper *big.Float types
            edgeWeight := EdgeWeight{
                Weight:    weight,
                Liquidity: big.NewFloat(0), // Default liquidity as 0
            }

            // Send edge data to the channel
            edgeChan <- struct {
                SrcToken   string
                DstToken   string
                EdgeWeight EdgeWeight
            }{
                SrcToken:   pair.SrcToken,
                DstToken:   pair.DstToken,
                EdgeWeight: edgeWeight,
            }
        }(pair)
    }

    // Close the channel once all Goroutines are done
    go func() {
        wg.Wait()
        close(edgeChan)
    }()

    // Collect edges from the channel and add them to the graph
    for edge := range edgeChan {
        if graph.AdjacencyList[edge.SrcToken] == nil {
            graph.AdjacencyList[edge.SrcToken] = make(map[string]EdgeWeight)
        }
        graph.AdjacencyList[edge.SrcToken][edge.DstToken] = edge.EdgeWeight
    }

    if len(graph.AdjacencyList) == 0 {
        log.Println("Graph is empty. No edges were added.")
    }

    log.Printf("Graph built with %d edges", len(graph.AdjacencyList))
    return graph, nil
}

func adjustProfitThreshold(baseThreshold float64, gasPrice *big.Float, volatilityFactor float64) float64 {
    gasPriceFloat, _ := gasPrice.Float64() // Convert *big.Float to float64
    return baseThreshold + gasPriceFloat*volatilityFactor
}

func calculateWeightFromLiquidity(dstAmount, gas float64) float64 {
    weightFactor := getEnvAsFloat("WEIGHT_FACTOR", 1.0)
    liquidityFactor := getEnvAsFloat("LIQUIDITY_FACTOR", 1.0)

    if dstAmount <= 0 {
        log.Println("dstAmount must be greater than zero for weight calculation")
        return 0
    }

    logDstAmount := math.Log(dstAmount)
    logGas := math.Log(gas + 1) // Avoid log(0)

    dampenedDstAmount := logDstAmount * weightFactor
    dampenedGas := logGas * liquidityFactor

    weight := dampenedDstAmount - dampenedGas
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
func MonitorMarketAndRebuildGraph(payload map[string]interface{}, updateInterval time.Duration, graphChan chan *WeightedGraph, baseThreshold float64, volatilityFactor float64) {
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

        // Adjust profit threshold dynamically based on gas price and volatility
        adjustedThreshold := adjustProfitThreshold(baseThreshold, gasPrice, volatilityFactor)

        // Validate and filter liquidity based on the adjusted profit threshold
        rawTokenPrices := payload["tokenPrices"].(map[string]float64)
        tokenPrices := convertTokenPricesToMap(rawTokenPrices)
        filteredLiquidity := processAndValidateLiquidity(updatedLiquidity, tokenPrices, adjustedThreshold)

        // Build the graph with the filtered liquidity data
        graph, profitableRoutes, err := buildAndProcessGraph(filteredLiquidity, tokenPrices, gasPrice)
        if err != nil {
            log.Printf("Failed to build graph: %v", err)
            continue
        }

        // Log generated routes for monitoring
        for _, route := range profitableRoutes {
            log.Printf("Profitable Route: %v, Profit: %s", route.Path, route.Profit.String())
        }

        // Send the updated graph through the channel
        graphChan <- graph
        log.Println("Graph updated successfully.")
    }
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
