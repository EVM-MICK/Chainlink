package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"container/heap"
        //"crypto/ecdsa"
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
        "sort"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
        //"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
        "github.com/ethereum/go-ethereum/rpc"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/gorilla/websocket"
        "github.com/patrickmn/go-cache"
	"github.com/ethereum/go-ethereum/crypto"
        //"github.com/joho/godotenv"
        //"github.com/shirou/gopsutil/v4/mem"
        //"github.com/deckarep/golang-set/v2"
        //"golang.org/x/crypto/pbkdf2"
        //"golang.org/x/crypto/scrypt"
        //"golang.org/x/crypto/sha3"
        //"golang.org/x/sys/unix"
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
// Graph represents a weighted graph
//type Graph map[string]map[string]float64



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

var apiRateLimits = make(map[string]*RateLimitTracker)

type TokenPair struct {
	SrcToken string `json:"srcToken"`
	DstToken string `json:"dstToken"`
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


// ComputeOptimalRoute finds the optimal route using Dijkstra's algorithm
func ComputeOptimalRoute(graph *WeightedGraph, startToken, endToken string) ([]string, *big.Float, error) {
	if _, exists := graph.AdjacencyList[startToken]; !exists {
		return nil, nil, fmt.Errorf("start token not in graph")
	}

	// Initialize distances and paths
	distances := make(map[string]*big.Float)
	previous := make(map[string]string)
	for token := range graph.AdjacencyList {
		distances[token] = big.NewFloat(math.Inf(1)) // Infinity
	}
	distances[startToken] = big.NewFloat(0)

	// Priority queue for Dijkstra's algorithm
	pq := make(PriorityQueue, 0)
	heap.Init(&pq)
	heap.Push(&pq, &Node{Token: startToken, Priority: 0})

	visited := make(map[string]bool)

	for pq.Len() > 0 {
		current := heap.Pop(&pq).(*Node)
		currentToken := current.Token

		if visited[currentToken] {
			continue
		}
		visited[currentToken] = true

		if currentToken == endToken {
			// Construct path from `previous` map
			path := []string{}
			for token := endToken; token != ""; token = previous[token] {
				path = append([]string{token}, path...)
			}
			return path, distances[endToken], nil
		}

		for neighbor, edge := range graph.AdjacencyList[currentToken] {
			if visited[neighbor] {
				continue
			}

			// Relax the edge
			newDistance := new(big.Float).Add(distances[currentToken], edge.Weight)
if newDistance.Cmp(distances[neighbor]) < 0 {
    distances[neighbor] = newDistance
    previous[neighbor] = currentToken

    // Convert *big.Float to float64 for Priority field
    floatValue, _ := newDistance.Float64()
    heap.Push(&pq, &Node{Token: neighbor, Priority: floatValue})
}

		}
	}

	return nil, nil, fmt.Errorf("no path found from %s to %s", startToken, endToken)
}


// calculateTotalGasCost calculates the total gas cost for a transaction.
func calculateTotalGasCost(gasPrice *big.Int, gasLimit uint64) *big.Int {
    // Ensure gas price and limit are valid
    if gasPrice == nil || gasPrice.Cmp(big.NewInt(0)) <= 0 {
        log.Println("Invalid gas price provided. Defaulting to 50 Gwei.")
        gasPrice = big.NewInt(50 * 1e9) // Default to 50 Gwei
    }

    if gasLimit == 0 {
        log.Println("Invalid gas limit provided. Defaulting to 800,000 units.")
        gasLimit = DefaultGasEstimate // Default gas limit
    }

    // Calculate total gas cost = gas price * gas limit
    totalGasCost := new(big.Int).Mul(gasPrice, big.NewInt(int64(gasLimit)))

    // Log for debugging
    log.Printf("Calculated total gas cost: %s wei", totalGasCost.String())
    return totalGasCost
}


// EvaluateRouteProfit evaluates the profitability of a given route
func evaluateRouteProfit(route []string, tokenPrices map[string]TokenPrice, gasPrice *big.Float) (*big.Int, error) {
    if len(route) < 2 {
        return nil, fmt.Errorf("invalid route, must contain at least two tokens")
    }

    // Starting capital
    amountIn := new(big.Int).Set(CAPITAL)
    totalGasCost := new(big.Int) // Initialize for gas cost calculation

    // Loop through the route to compute trade flow
    for i := 0; i < len(route)-1; i++ {
        fromToken := route[i]
        toToken := route[i+1]

        // Fetch price and liquidity data
        fromData, ok := tokenPrices[fromToken]
        if !ok {
            return nil, fmt.Errorf("missing price data for token: %s", fromToken)
        }
        toData, ok := tokenPrices[toToken]
        if !ok {
            return nil, fmt.Errorf("missing price data for token: %s", toToken)
        }

        // Adjust for slippage
        adjustedAmountFloat, err := adjustForSlippage(new(big.Float).SetInt(amountIn), fromData.Liquidity)
        if err != nil {
            return nil, fmt.Errorf("slippage adjustment failed for token %s: %v", fromToken, err)
        }

        // Convert adjustedAmountFloat (*big.Float) to *big.Int
        adjustedAmount := new(big.Int)
        adjustedAmountFloat.Int(adjustedAmount)

        // Update the trading amount
        priceRatio := new(big.Float).Quo(toData.Price, fromData.Price) // priceRatio = toPrice / fromPrice
        tradeAmount := new(big.Float).Mul(new(big.Float).SetInt(adjustedAmount), priceRatio) // tradeAmount = adjustedAmount * priceRatio

        // Convert tradeAmount (*big.Float) to *big.Int
        amountIn = new(big.Int)
        tradeAmount.Int(amountIn)

        // Calculate gas cost for this trade (use a constant gas limit per hop)
        gasPriceInt := new(big.Int)
        gasPrice.Int(gasPriceInt) // Convert *big.Float gasPrice to *big.Int

        hopGasCost := calculateTotalGasCost(gasPriceInt, DefaultGasEstimate)
        totalGasCost.Add(totalGasCost, hopGasCost)

        // Ensure remaining amount is positive
        if amountIn.Cmp(big.NewInt(0)) <= 0 {
            return nil, fmt.Errorf("trade resulted in zero or negative amount after hop %s -> %s", fromToken, toToken)
        }
    }

    // Calculate net profit: final amount - starting capital - gas costs
    netProfit := new(big.Int).Sub(new(big.Int).Sub(amountIn, CAPITAL), totalGasCost)

    // Log the route and profit for debugging
    log.Printf("Route evaluated: %v, Profit: %s wei", route, netProfit.String())

    // Check against minimum profit threshold
    if netProfit.Cmp(MINIMUM_PROFIT_THRESHOLD) < 0 {
        log.Printf("Route did not meet the profit threshold.")
        return nil, nil
    }

    return netProfit, nil
}



// Adjust for slippage
func adjustForSlippage(amountIn *big.Float, liquidity *big.Float) (*big.Float, error) {
	if liquidity == nil || liquidity.Cmp(big.NewFloat(0)) <= 0 {
		return nil, errors.New("invalid liquidity: must be greater than zero")
	}

	slippage := new(big.Float).Mul(amountIn, big.NewFloat(0.01)) // Example: 1% slippage
	adjustedAmount := new(big.Float).Sub(amountIn, slippage)

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
func generateRoutesHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ChainID         int64                    `json:"chainId"`
		StartToken      string                   `json:"startToken"`
		StartAmount     string                   `json:"startAmount"`
		MaxHops         int                      `json:"maxHops"`
		ProfitThreshold string                   `json:"profitThreshold"`
		TokenPrices     map[string]float64       `json:"tokenPrices"`
		Liquidity       []map[string]interface{} `json:"liquidity"`
	}

	// Parse JSON body
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request payload", http.StatusBadRequest)
		log.Printf("Error decoding request body: %v", err)
		return
	}

	// Validate required fields
	if !common.IsHexAddress(req.StartToken) || req.ChainID <= 0 || req.MaxHops <= 0 {
		http.Error(w, "Invalid input parameters", http.StatusBadRequest)
		log.Println("Invalid input parameters detected in the request.")
		return
	}

	// Parse Start Amount
	startAmount := new(big.Int)
	if _, success := startAmount.SetString(req.StartAmount, 10); !success || startAmount.Cmp(big.NewInt(0)) <= 0 {
		http.Error(w, "Invalid startAmount format or value", http.StatusBadRequest)
		log.Println("Invalid startAmount format or value.")
		return
	}

	// Parse Profit Threshold
	profitThreshold := new(big.Int)
	if _, success := profitThreshold.SetString(req.ProfitThreshold, 10); !success || profitThreshold.Cmp(big.NewInt(0)) <= 0 {
		http.Error(w, "Invalid profitThreshold format or value", http.StatusBadRequest)
		log.Println("Invalid profitThreshold format or value.")
		return
	}

	// Validate and adjust Start Token Decimals
	tokenDecimals := getTokenDecimals(req.StartToken)
	if tokenDecimals < 0 {
		http.Error(w, "Unable to fetch token decimals for the start token", http.StatusBadRequest)
		log.Printf("Invalid token decimals for token: %s", req.StartToken)
		return
	}

	adjustedAmount := new(big.Int).Mul(startAmount, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(tokenDecimals)), nil))
	if adjustedAmount.Cmp(big.NewInt(0)) <= 0 {
		http.Error(w, "Invalid startAmount when adjusted for token decimals", http.StatusBadRequest)
		log.Println("Invalid adjusted startAmount.")
		return
	}

	// Log inputs for debugging
	log.Printf("Request data: ChainID=%d, StartToken=%s, MaxHops=%d, ProfitThreshold=%s, TokenPrices=%v, Liquidity=%v",
		req.ChainID, req.StartToken, req.MaxHops, profitThreshold.String(), req.TokenPrices, req.Liquidity)

	// Compute profitable routes based on passed TokenPrices and Liquidity
	profitableRoutes, err := computeProfitableRoutes(req.TokenPrices, req.Liquidity)
	if err != nil {
		http.Error(w, "Failed to compute profitable routes", http.StatusInternalServerError)
		log.Printf("Error computing profitable routes: %v", err)
		return
	}

	// Further filter routes
	filteredRoutes, err := filterRoutes(profitableRoutes, req.ChainID, req.StartToken, adjustedAmount, req.MaxHops, profitThreshold)
	if err != nil {
		http.Error(w, "Failed to filter profitable routes", http.StatusInternalServerError)
		log.Printf("Error filtering profitable routes: %v", err)
		return
	}

	// Respond with the computed and filtered routes
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"routes": filteredRoutes,
	}); err != nil {
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
		log.Printf("Error encoding response: %v", err)
		return
	}

	log.Println("Successfully computed and returned filtered routes.")
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


func generateRoutes(chainID int64, startToken string, startAmount *big.Int, maxHops int, profitThreshold *big.Int) ([]Route, error) {
    // Validate the start token address
    if !common.IsHexAddress(startToken) {
        return nil, fmt.Errorf("invalid start token address: %s", startToken)
    }

    if startAmount.Cmp(big.NewInt(0)) <= 0 || profitThreshold.Cmp(big.NewInt(0)) <= 0 {
        return nil, fmt.Errorf("startAmount and profitThreshold must be positive values")
    }

    // Fallback directly to hardcoded stable token addresses
   // Convert hardcodedStableAddresses to StableToken format
stableTokens := make([]StableToken, len(hardcodedStableAddresses))
for i, addr := range hardcodedStableAddresses {
    stableTokens[i] = StableToken{Address: addr}
}
validStableTokenAddresses := filterValidAddresses(stableTokens)

    if len(validStableTokenAddresses) == 0 {
        return nil, fmt.Errorf("no valid stable token addresses available")
    }

    // Generate token pairs and build the graph using real-time data
    tokenPairs := generateTokenPairs(validStableTokenAddresses)
    graph, err := BuildGraph(tokenPairs, chainID)
    if err != nil {
        return nil, fmt.Errorf("failed to build graph: %v", err)
    }

    // Calculate average liquidity to adjust the max hops
   averageLiquidity, err := calculateAverageLiquidity(validStableTokenAddresses, chainID, startToken)
    if err != nil {
        log.Fatalf("Failed to calculate average liquidity: %v", err)
    }
    log.Printf("Average Liquidity: %s", averageLiquidity.String())
    maxHops = adjustMaxHops(maxHops, averageLiquidity)

    var profitableRoutes []Route
    var mu sync.Mutex
    var wg sync.WaitGroup

    // Iterate over all end tokens and find routes
    for _, endToken := range validStableTokenAddresses {
        if strings.EqualFold(endToken, startToken) {
            continue
        }

        wg.Add(1)
        go func(endToken string) {
            defer wg.Done()

            // Use Dijkstra's algorithm to find the shortest path
            path, cost, err := ComputeOptimalRoute(graph, startToken, endToken)
            if err != nil || len(path) <= 1 {
                return
            }

            // Convert `cost` from *big.Float to *big.Int for compatibility
            costInt := new(big.Int)
            cost.Int(costInt)

            // Calculate profit
            profit := new(big.Int).Sub(startAmount, costInt)
            if profit.Cmp(profitThreshold) > 0 {
                mu.Lock()
                profitableRoutes = append(profitableRoutes, Route{
                    Path:   path,
                    Profit: profit,
                })
                mu.Unlock()
                log.Printf("Profitable route found: %s with profit: %s", strings.Join(path, " ➡️ "), profit.String())
            }
        }(endToken)
    }

    wg.Wait()

    // Execute profitable routes
    for _, route := range profitableRoutes {
        if route.Profit.Cmp(MINIMUM_PROFIT_THRESHOLD) > 0 {
            log.Printf("Executing profitable route: %v, Profit: %s", route.Path, route.Profit.String())
            if err := executeRoute(route.Path, route.Profit); err != nil {
                log.Printf("Failed to execute route: %v", err)
            }
        }
    }

    // Return sorted and limited routes
    return sortAndLimitRoutes(profitableRoutes, 3), nil
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
	requiredVars := []string{"ONEINCH_API_KEY", "INFURA_URL", "PRIVATE_KEY"}
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

	// Convert gas price and gas limit to big.Int
	gasPrice := new(big.Int).Set(tx.GasPrice)
	gasLimit := uint64(tx.Gas)

	// Parse sender and receiver addresses
	//fromAddress := common.HexToAddress(tx.From)
	toAddress := common.HexToAddress(tx.To)

	// Create transaction data
	rawTx := types.NewTransaction(
		permitDetails.Nonce, // Use fetched nonce
		toAddress,
		new(big.Int).Set(tx.Value), // Value in Wei
		gasLimit,
		gasPrice,
		common.FromHex(tx.Data), // Include Permit2 details in data if necessary
	)

	// Load private key for signing
	privateKey, err := crypto.HexToECDSA(os.Getenv("PRIVATE_KEY"))
	if err != nil {
		return nil, fmt.Errorf("failed to load private key: %v", err)
	}

	// Sign the transaction
	chainID, err := client.NetworkID(context.Background())
	if err != nil {
		return nil, fmt.Errorf("failed to fetch chain ID: %v", err)
	}

	signedTx, err := types.SignTx(rawTx, types.NewEIP155Signer(chainID), privateKey)
	if err != nil {
		return nil, fmt.Errorf("failed to sign transaction: %v", err)
	}

	// Send the transaction
	err = client.SendTransaction(context.Background(), signedTx)
	if err != nil {
		return nil, fmt.Errorf("failed to send transaction: %v", err)
	}

	// Create a receipt struct
	txHash := signedTx.Hash().Hex()
	log.Printf("Transaction sent successfully. Hash: %s", txHash)

	return &Receipt{TransactionHash: txHash}, nil
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


func BuildGraph(tokenPairs []TokenPair, chainID int64) (*WeightedGraph, error) {
    graph := &WeightedGraph{AdjacencyList: make(map[string]map[string]EdgeWeight)}

    for _, pair := range tokenPairs {
        price, liquidity, err := fetchTokenPairData(pair.SrcToken, pair.DstToken, chainID)
        if err != nil {
            log.Printf("Skipping pair %s -> %s: %v", pair.SrcToken, pair.DstToken, err)
            continue
        }

        if graph.AdjacencyList[pair.SrcToken] == nil {
            graph.AdjacencyList[pair.SrcToken] = make(map[string]EdgeWeight)
        }

        graph.AdjacencyList[pair.SrcToken][pair.DstToken] = EdgeWeight{
            Weight:    calculateWeight(price, liquidity),
            Liquidity: liquidity,
        }
    }
    return graph, nil
}


// Dynamic weight calculation function
func calculateWeight(price, liquidity *big.Float) *big.Float {
    // Fetch configurable factors from environment variables
    weightFactor := getEnvAsFloat("WEIGHT_FACTOR", 1.0)      // Default to 1.0 if not set
    liquidityFactor := getEnvAsFloat("LIQUIDITY_FACTOR", 1.0) // Default to 1.0 if not set

    // Custom formula: weight = (1 / price) * weightFactor + liquidityFactor * liquidity
    inversePrice := new(big.Float).Quo(big.NewFloat(1), price)      // Compute 1/price
    weightedPrice := new(big.Float).Mul(inversePrice, big.NewFloat(weightFactor))
    liquidityWeight := new(big.Float).Mul(liquidity, big.NewFloat(liquidityFactor))

    return new(big.Float).Add(weightedPrice, liquidityWeight) // Sum up weighted components
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


func fetchTokenPairData(srcToken, dstToken string, chainID int64) (*big.Float, *big.Float, error) {
    prices, err := FetchTokenPrices([]string{srcToken, dstToken})
    if err != nil {
        return nil, nil, fmt.Errorf("failed to fetch prices: %w", err)
    }

    srcPrice, srcExists := prices[srcToken]
    dstPrice, dstExists := prices[dstToken]
    if !srcExists || !dstExists {
        return nil, nil, fmt.Errorf("price data missing for tokens")
    }

    liquidity, err := estimateLiquidity(chainID, srcToken, dstToken)
    if err != nil {
        return nil, nil, fmt.Errorf("failed to estimate liquidity: %w", err)
    }

    return big.NewFloat(srcPrice / dstPrice), liquidity, nil
}


func calculateAverageLiquidity(tokens []string, chainID int64, startToken string) (*big.Float, error) {
	totalLiquidity := big.NewFloat(0)
	count := 0

	var mu sync.Mutex
	var wg sync.WaitGroup

	for _, token := range tokens {
		wg.Add(1)
		go func(token string) {
			defer wg.Done()

			// Estimate liquidity for each token
			liquidity, err := estimateLiquidity(chainID, startToken, token)
			if err != nil {
				log.Printf("Failed to estimate liquidity for token %s: %v", token, err)
				return
			}

			// Accumulate total liquidity and count valid tokens
			mu.Lock()
			if liquidity.Cmp(big.NewFloat(0)) > 0 {
				totalLiquidity.Add(totalLiquidity, liquidity)
				count++
			}
			mu.Unlock()
		}(token)
	}

	// Wait for all goroutines to complete
	wg.Wait()

	// Return average liquidity or zero if no valid tokens were processed
	if count > 0 {
		return new(big.Float).Quo(totalLiquidity, big.NewFloat(float64(count))), nil
	}
	return big.NewFloat(0), nil
}

func estimateLiquidity(chainID int64, srcToken, dstToken string) (*big.Float, error) {
    orderBook, err := fetchOrderBookDepth(srcToken, dstToken, chainID)
    if err != nil {
        return nil, fmt.Errorf("failed to fetch order book: %v", err)
    }

    totalLiquidity := orderBookLiquidity(orderBook)
    if totalLiquidity.Cmp(big.NewFloat(0)) <= 0 {
        return nil, fmt.Errorf("no liquidity available for %s -> %s", srcToken, dstToken)
    }

    low := big.NewFloat(1e18) // Minimum trade size
    high := big.NewFloat(1e24) // Maximum trade size
    bestAmount := new(big.Float).Set(low)

    for low.Cmp(high) <= 0 {
        
        mid := new(big.Float).Add(low, high)
        mid.Quo(mid, big.NewFloat(2))
        adjustedAmount, err := adjustForSlippage(mid, totalLiquidity)
        if err != nil || adjustedAmount.Cmp(big.NewFloat(0)) <= 0 {
            high = mid.Sub(mid, big.NewFloat(1))
        } else {
            bestAmount.Set(mid)
            low = mid.Add(mid, big.NewFloat(1))
        }
    }
    return bestAmount, nil
}


func orderBookLiquidity(orderBook []interface{}) *big.Float {
    totalLiquidity := big.NewFloat(0)

    for _, order := range orderBook {
        liquidity := extractLiquidityFromOrder(order)
        totalLiquidity.Add(totalLiquidity, liquidity)
    }

    return totalLiquidity
}

func extractLiquidityFromOrder(order interface{}) *big.Float {
	if orderMap, ok := order.(map[string]interface{}); ok {
		if liquidityValue, exists := orderMap["liquidity"]; exists {
			switch value := liquidityValue.(type) {
			case string:
				liquidity, _, err := big.ParseFloat(value, 10, 256, big.ToNearestEven)
				if err != nil {
					log.Printf("Error parsing liquidity from string: %v", err)
					return big.NewFloat(0)
				}
				return liquidity
			case float64:
				return big.NewFloat(value)
			case int:
				return big.NewFloat(float64(value))
			case *big.Float:
				return value
			default:
				log.Printf("Unsupported liquidity type: %T", value)
			}
		}
	}
	return big.NewFloat(0)
}


func adjustMaxHops(maxHops int, avgLiquidity *big.Float) int {
	if avgLiquidity.Cmp(big.NewFloat(10000000)) > 0 {
		return min(maxHops+1, 4)
	} else if avgLiquidity.Cmp(big.NewFloat(500000)) < 0 {
		return max(maxHops-1, 1)
	}
	return maxHops
}



func find(graph *Graph, startToken, endToken string) ([]string, *big.Int, error) {
	// Mock implementation of graph traversal. Replace with real Dijkstra or BFS logic.
	if _, exists := graph.AdjacencyList[startToken]; !exists {
		return nil, nil, fmt.Errorf("start token not in graph")
	}
	path := []string{startToken, endToken}
	cost := big.NewInt(1000000) // Mock cost
	return path, cost, nil
}

func sortAndLimitRoutes(routes []Route, limit int) []Route {
	sort.Slice(routes, func(i, j int) bool {
		return routes[i].Profit.Cmp(routes[j].Profit) > 0
	})
	if len(routes) > limit {
		return routes[:limit]
	}
	return routes
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
	toAddress := tx.To()
	if toAddress == nil {
		return
	}

	// Check if the transaction targets a relevant contract
	if _, exists := targetContracts[toAddress.Hex()]; !exists {
		return
	}

	// Extract transaction input data
	inputData := tx.Data()
	if len(inputData) < 4 {
		log.Println("Transaction data too short to decode")
		return
	}

	methodSig := inputData[:4] // First 4 bytes are the method ID

	// Attempt decoding with Uniswap ABI
	if method, err := uniswapABI.MethodById(methodSig); err == nil {
		args := make(map[string]interface{})
		if err := method.Inputs.UnpackIntoMap(args, inputData[4:]); err != nil {
			log.Printf("Failed to decode Uniswap transaction: %v", err)
			return
		}

		log.Printf("Decoded Uniswap transaction: Method=%s, Args=%v", method.Name, args)
		processUniswapTransaction(method.Name, args)
		return
	}

	// Attempt decoding with SushiSwap ABI
	if method, err := sushiSwapABI.MethodById(methodSig); err == nil {
		args := make(map[string]interface{})
		if err := method.Inputs.UnpackIntoMap(args, inputData[4:]); err != nil {
			log.Printf("Failed to decode SushiSwap transaction: %v", err)
			return
		}

		log.Printf("Decoded SushiSwap transaction: Method=%s, Args=%v", method.Name, args)
		processSushiSwapTransaction(method.Name, args)
		return
	}

	// Log unknown transaction
	log.Printf("Unknown transaction targeting contract: %s", toAddress.Hex(), err)
}

// Process Uniswap-specific transactions
func processUniswapTransaction(methodName string, args map[string]interface{}) {
	switch methodName {
	case "exactInput":
		params := args["params"].(map[string]interface{})
		path := params["path"].([]byte) // Multi-hop path as a byte array
		decodedPath, err := decodePath(path) // Decode path to token addresses
                if err != nil {
                 return fmt.Errorf("failed to decode path: %v", err)
                }
		amountIn := params["amountIn"].(*big.Int)
		amountOutMinimum := params["amountOutMinimum"].(*big.Int)

		log.Printf("Uniswap exactInput: Path=%v, AmountIn=%s, AmountOutMin=%s",
			decodedPath, amountIn.String(), amountOutMinimum.String())

	case "exactInputSingle":
		params := args["params"].(map[string]interface{})
		tokenIn := params["tokenIn"].(common.Address)
		tokenOut := params["tokenOut"].(common.Address)
		amountIn := params["amountIn"].(*big.Int)
		amountOutMinimum := params["amountOutMinimum"].(*big.Int)

		log.Printf("Uniswap exactInputSingle: TokenIn=%s, TokenOut=%s, AmountIn=%s, AmountOutMin=%s",
			tokenIn.Hex(), tokenOut.Hex(), amountIn.String(), amountOutMinimum.String())

	default:
		log.Printf("Unhandled Uniswap method: %s", methodName)
	}
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
func processSushiSwapTransaction(methodName string, args map[string]interface{}) {
	switch methodName {
	case "swapExactTokensForTokens":
		amountIn := args["amountIn"].(*big.Int)
		amountOutMin := args["amountOutMin"].(*big.Int)
		path := args["path"].([]common.Address)

		decodedPath := decodePathSushi(path) // Decode path to token addresses

		log.Printf("SushiSwap swapExactTokensForTokens: AmountIn=%s, AmountOutMin=%s, Path=%v",
			amountIn.String(), amountOutMin.String(), decodedPath)

	case "swapTokensForExactTokens":
		amountOut := args["amountOut"].(*big.Int)
		amountInMax := args["amountInMax"].(*big.Int)
		path := args["path"].([]common.Address)

		decodedPath := decodePathSushi(path) // Decode path to token addresses

		log.Printf("SushiSwap swapTokensForExactTokens: AmountOut=%s, AmountInMax=%s, Path=%v",
			amountOut.String(), amountInMax.String(), decodedPath)

	default:
		log.Printf("Unhandled SushiSwap method: %s", methodName)
	}
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

	for {
		select {
		case <-ctx.Done():
			log.Println("Mempool monitoring stopped due to context cancellation.")
			return nil
		default:
			// Retry connection and subscription
			err := monitorMempool(ctx, targetContracts, rpcURL)
			if err != nil {
				log.Printf("Error in mempool monitoring: %v. Retrying...", err)
				time.Sleep(5 * time.Second) // Delay before retry
			}
		}
	}
}

func monitorMempool(ctx context.Context, targetContracts map[string]bool, rpcURL string) error {
	ch := make(chan string) // Channel type for transaction hashes
	var clientResult interface{}
	var err error

	// Retry logic for connecting to Ethereum client
	clientResult, err = Retry(func() (interface{}, error) {
		return ethclient.Dial(rpcURL)
	}, 3, 2*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect to Ethereum client after retries: %v", err)
	}

	client := clientResult.(*ethclient.Client)
	defer client.Close()
	log.Println("Connected to Ethereum client. Monitoring mempool...")

	rpcClient, err := rpc.Dial(os.Getenv("RPC_URL"))
	if err != nil {
		return fmt.Errorf("failed to connect to RPC client: %v", err)
	}

	for {
		// Retry logic for subscribing to pending transactions
		sub, err := rpcClient.Subscribe(ctx, "newPendingTransactions", ch) // Correct argument order
		if err != nil {
			log.Printf("Failed to subscribe to pending transactions: %v. Retrying...", err)
			time.Sleep(5 * time.Second) // Delay before retry
			continue
		}

		log.Println("Subscribed to newPendingTransactions")

		// Process transactions as they arrive
		for {
			select {
			case err := <-sub.Err():
				log.Printf("Subscription error: %v. Retrying subscription...", err)
				sub.Unsubscribe()
				break // Exit the inner loop to retry subscription
			case txHash := <-ch: // txHash is of type string
				// Fetch transaction details using txHash
				tx, _, err := client.TransactionByHash(ctx, common.HexToHash(txHash))
				if err != nil {
					log.Printf("Failed to fetch transaction details for hash %s: %v", txHash, err)
					continue
				}
				go processTransaction(client, tx, targetContracts)
			case <-ctx.Done():
				log.Println("Shutting down mempool monitoring...")
				sub.Unsubscribe()
				return nil
			}
		}
	}
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
		client.Conn.Close()
		client.CancelFunc()
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

	// Start WebSocket server
	http.HandleFunc("/ws", wsHandler)
	go func() {
		log.Println("WebSocket server listening on :8080/ws")
		log.Fatal(http.ListenAndServe(":8080", nil))
	}()

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

	// Start REST API server for route generation
	http.HandleFunc("/generate-routes", generateRoutesHandler)

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
