package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"container/heap"
        "crypto/ecdsa"
	"math/big"
	"sync"
	"io/ioutil"
	"net/http"
	"os"
	"strings"
	"time"
	"math"
	"errors"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
        "github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/gorilla/websocket"
        "github.com/patrickmn/go-cache"
	"github.com/ethereum/go-ethereum/crypto"
        "github.com/joho/godotenv"
        "github.com/shirou/gopsutil/v4/mem"
        "github.com/deckarep/golang-set/v2"
        "golang.org/x/crypto/pbkdf2"
        "golang.org/x/crypto/scrypt"
        "golang.org/x/crypto/sha3"
        "golang.org/x/sys/unix"
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

var CAPITAL *big.Int // Declare CAPITAL globally
var apiRateLimiter = NewRateLimiter(5, time.Second) // Allow 5 API calls per second
var wg sync.WaitGroup
var abis = map[string]abi.ABI{}

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
	ChainID      int      `json:"chainId"`
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
var broadcastChannel = make(chan []byte)

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
	wsClients    = make(map[*WebSocketClient]bool)
	clientsMutex sync.Mutex
	upgrader     = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}
)


// Global cache instance for stable token data
var stableTokenCache = cache.New(10*time.Minute, 15*time.Minute) // Default expiration and cleanup interval
var tokenPriceCache = cache.New(10*time.Minute, 15*time.Minute)
var orderBookCache = cache.New(10*time.Minute, 15*time.Minute)


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
	cache map[string]CacheEntry
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
	data      interface{}
	timestamp time.Time
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


// var upgrader = websocket.Upgrader{
// 	CheckOrigin: func(r *http.Request) bool {
// 		return true
// 	},
// }

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
	Path   []string  `json:"path"`
	Profit *big.Int  `json:"profit"`
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

	result, err := Retry(operation, 3, 1*time.Second)
	if err != nil {
		return nil, err
	}
	return result.([]byte), nil
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
func NewRateLimiter(capacity int, refillInterval time.Duration) *RateLimiter {
	rl := &RateLimiter{
		capacity: capacity,
		tokens:   capacity,
		interval: refillInterval,
		stop:     make(chan bool),
	}

	// Start the refill process in a separate Goroutine
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
	var lastErr error

	for attempt := 1; attempt <= maxRetries; attempt++ {
		result, err := operation()
		if err == nil {
			return result, nil
		}

		log.Printf("Retry attempt %d/%d failed: %v", attempt, maxRetries, err)
		lastErr = err
		time.Sleep(backoff)
		backoff *= 2
	}

	return nil, fmt.Errorf("operation failed after %d retries: %w", maxRetries, lastErr)
}

// getStableTokenList fetches the stable token list or falls back to hardcoded tokens
func getStableTokenList(chainID int) ([]Token, error) {
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
	//setToStableTokenCache(cacheKey, stableTokens, stableTokenCache)
        setToStableTokenCache("key", value, 10*time.Minute)
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
	// Retrieve the entry from go-cache
	data, found := stableTokenCache.Get(key)
	if !found {
		log.Printf("Cache miss for key: %s", key)
		return nil, false
	}

	log.Printf("Cache hit for key: %s", key)
	return data, true
}

// func setToStableTokenCache(key string, value interface{}, duration time.Duration) {
// 	// Add entry to go-cache with a specific expiration duration
// 	stableTokenCache.Set(key, value, duration)
// 	log.Printf("Added key: %s to cache with expiration: %v", key, duration)
// }

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

func setToStableTokenCache(key string, value interface{}, duration time.Duration) {
	stableTokenCache.Set(key, value, duration)
	defer stableTokenCache.Set(key, value, duration)
	stableTokenCache.cache[key] = CacheEntry{
		data:      value,
		timestamp: time.Now().Add(duration),
	}
}


// Pop removes and returns the node with the highest priority
// func (pq *PriorityQueue) Pop() interface{} {
// 	old := *pq
// 	n := len(old)
// 	node := old[n-1]
// 	old[n-1] = nil // Avoid memory leak
// 	node.Index = -1
// 	*pq = old[0 : n-1]
// 	return node
// }

// // Update modifies the priority of a node in the queue
// func (pq *PriorityQueue) Update(node *Node, priority float64) {
// 	node.Priority = priority
// 	heap.Fix(pq, node.Index)
// }

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


// EvaluateRouteProfit evaluates the profitability of a given route
func evaluateRouteProfit(route []string, tokenPrices map[string]TokenPrice, gasPrice *big.Float) (*big.Int, error) {
	if len(route) < 2 {
		return nil, fmt.Errorf("invalid route, must contain at least two tokens")
	}

	amountIn := new(big.Float).SetInt(CAPITAL) // Start with the full trading capital
	totalGasCost := new(big.Float)

	for i := 0; i < len(route)-1; i++ {
		fromToken := route[i]
		toToken := route[i+1]

		// Retrieve token data
		fromData, ok := tokenPrices[fromToken]
		if !ok {
			return nil, fmt.Errorf("missing price data for token: %s", fromToken)
		}
		toData, ok := tokenPrices[toToken]
		if !ok {
			return nil, fmt.Errorf("missing price data for token: %s", toToken)
		}

		// Ensure liquidity is valid before calling adjustForSlippage
		if fromData.Liquidity == nil || fromData.Liquidity.Cmp(big.NewFloat(0)) <= 0 {
			return nil, fmt.Errorf("invalid liquidity for token: %s", fromToken)
		}

		// Adjust trade size for slippage
		adjustedAmount, err := adjustForSlippage(amountIn, fromData.Liquidity)
		if err != nil {
			return nil, fmt.Errorf("slippage adjustment error: %v", err)
		}

		// Calculate new amountIn after this hop
		amountIn.Mul(adjustedAmount, toData.Price)
		amountIn.Quo(amountIn, fromData.Price)

		// Ensure positive output remains
		if amountIn.Cmp(big.NewFloat(0)) <= 0 {
			return nil, fmt.Errorf("negative or zero output at hop: %s -> %s", fromToken, toToken)
		}

		// Accumulate gas cost
		hopGasCost := new(big.Float).Mul(gasPrice, big.NewFloat(DefaultGasEstimate)) // Adjust gas per hop if needed
		totalGasCost.Add(totalGasCost, hopGasCost)
	}

	// Convert results to big.Int for comparison
	finalAmountIn := new(big.Int)
	amountIn.Int(finalAmountIn)
	finalGasCost := new(big.Int)
	totalGasCost.Int(finalGasCost)

	// Calculate profit
	profit := new(big.Int).Sub(finalAmountIn, CAPITAL)
	profit.Sub(profit, finalGasCost)

	// Ensure profit is positive
	if profit.Cmp(big.NewInt(0)) > 0 {
		log.Printf("Profitable route: %v with profit: %s", route, profit.String())
		return profit, nil
	}

	log.Printf("Route %v did not meet the profit threshold.", route)
	return nil, nil
}

// AdjustForSlippage adjusts the trade size based on liquidity
func adjustForSlippage(amountIn *big.Float, liquidity *big.Float) (*big.Float, error) {
	// Ensure liquidity is greater than zero to avoid division by zero
	if liquidity == nil || liquidity.Cmp(big.NewFloat(0)) <= 0 {
		return nil, errors.New("invalid liquidity: must be greater than zero")
	}

	// Calculate slippage as a percentage of the input amount
	slippage := new(big.Float).Mul(amountIn, big.NewFloat(0.01)) // Example: 1% slippage
	adjustedAmount := new(big.Float).Sub(amountIn, slippage)

	// Ensure the adjusted amount remains positive
	if adjustedAmount.Cmp(big.NewFloat(0)) <= 0 {
		return nil, errors.New("adjusted amount is negative or zero after slippage")
	}

	return adjustedAmount, nil
}



// CalculateDynamicProfitThreshold dynamically calculates the profit threshold
func calculateDynamicProfitThreshold(gasPrice *big.Float) (*big.Int, error) {
	gasCost := new(big.Float).Mul(gasPrice, big.NewFloat(DefaultGasEstimate)) // Estimate gas for 800k units
	flashLoanFee := new(big.Float).Mul(new(big.Float).SetInt(CAPITAL), FLASHLOAN_FEE_RATE)
	totalCost := new(big.Float).Add(gasCost, flashLoanFee)

	profitThreshold := new(big.Float).Add(totalCost, new(big.Float).SetInt(MINIMUM_PROFIT_THRESHOLD))
	result := new(big.Int)
	profitThreshold.Int(result)

	log.Printf("Dynamic profit threshold: %s", result.String())
	return result, nil
}


// Helper to set a value in the cache
func setToCache(key string, value interface{}) {
	quoteCache.mu.Lock()         // Acquire the lock
	defer quoteCache.mu.Unlock() // Release the lock after the operation
	quoteCache.cache[key] = value
}

// Helper to get a value from the cache
func getFromCache(key string) (interface{}, bool) {
	quoteCache.mu.Lock()         // Acquire the lock
	defer quoteCache.mu.Unlock() // Ensure the lock is released, even if the function exits early
	value, exists := quoteCache.cache[key]
	return value, exists
}

func getFromOrderBookCache(key string) (interface{}, bool) {
	orderBookCache.mu.Lock()
	defer orderBookCache.mu.Unlock()
	value, exists := orderBookCache.cache[key]
	return value, exists
}

func setToOrderBookCache(key string, value interface{}, duration time.Duration) {
	orderBookCache.Set(key, value, duration)
	defer orderBookCache.Set(key, value, duration)
	orderBookCache.Set[key] = CacheEntry{
		data:      value,
		timestamp: time.Now().Add(duration),
	}
}

func adjustForDecimals(amount *big.Int, decimals int) *big.Int {
	factor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	return new(big.Int).Mul(amount, factor)
}


// Helper function for exponential backoff retries
func fetchWithRetries(url string, headers map[string]string) ([]byte, error) {
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

		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("unexpected status code: %d", resp.StatusCode)
		}

		return ioutil.ReadAll(resp.Body)
	}

	result, err := Retry(operation, 3, time.Second)
	if err != nil {
		return nil, err
	}
	return result.([]byte), nil
}

// Fetch a single quote with caching and retries
func fetchQuote(chainID int, srcToken, dstToken string, amount string, complexityLevel, slippage int) (map[string]interface{}, error) {
	cacheKey := fmt.Sprintf("%s_%s_%s", srcToken, dstToken, amount)

	// Check cache
	if cachedQuote, exists := getFromCache(cacheKey); exists {
		log.Printf("Using cached quote for %s", cacheKey)
		return cachedQuote.(map[string]interface{}), nil
	}

	// Construct API request
	url := fmt.Sprintf("https://api.1inch.dev/swap/v6.0/%d/quote?src=%s&dst=%s&amount=%s&complexityLevel=%d&includeTokensInfo=true&includeProtocols=true&includeGas=true",
		chainID, srcToken, dstToken, amount, complexityLevel)

	headers := map[string]string{
		"Authorization": fmt.Sprintf("Bearer %s", getEnv("ONEINCH_API_KEY", "")),
	}

	// Fetch quote with retries
	log.Printf("Fetching quote for %s ➡️ %s, amount: %s", srcToken, dstToken, amount)
	data, err := fetchWithRetries(url, headers, 3, 1*time.Second)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch quote for %s ➡️ %s: %v", srcToken, dstToken, err)
	}

	// Check response for non-200 status
	if len(data) == 0 {
		return nil, fmt.Errorf("empty response from quote API for %s ➡️ %s", srcToken, dstToken)
	}

	var quote map[string]interface{}
	if err := json.Unmarshal(data, &quote); err != nil {
		return nil, fmt.Errorf("failed to parse quote response: %v", err)
	}

	// Cache the result
	setToCache(cacheKey, quote)
	return quote, nil
}

// Fetch multiple quotes concurrently with rate limiting
func fetchMultipleQuotes(chainID int, tokenPairs [][2]string, amount string, complexityLevel, slippage int) ([]map[string]interface{}, error) {
	limit := make(chan struct{}, 5) // Limit concurrency to 5
	var wg sync.WaitGroup
	results := make([]map[string]interface{}, len(tokenPairs))
	errors := make([]error, len(tokenPairs))

	for i, pair := range tokenPairs {
		wg.Add(1)
		limit <- struct{}{} // Acquire a slot
		go func(i int, srcToken, dstToken string) {
			defer wg.Done()
			defer func() { <-limit }() // Release the slot

			quote, err := fetchQuote(chainID, srcToken, dstToken, amount, complexityLevel, slippage)
			if err != nil {
				errors[i] = err
				return
			}
			results[i] = quote
		}(i, pair[0], pair[1])
	}

	wg.Wait()

	// Filter out any failed results
	var validResults []map[string]interface{}
	for i, res := range results {
		if errors[i] == nil {
			validResults = append(validResults, res)
		} else {
			log.Printf("Error fetching quote for pair %v: %v", tokenPairs[i], errors[i])
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
	orderBookCache.mu.Lock()
	defer orderBookCache.mu.Unlock()
	orderBookCache.cache[key] = CacheEntry{
		data:      value,
		timestamp: time.Now().Add(duration),
	}
}

// Helper to get value from cache
func cacheGetOrderBook(key string) (interface{}, bool) {
	orderBookCache.mu.Lock()
	defer orderBookCache.mu.Unlock()
	entry, exists := orderBookCache.cache[key]
	if exists && time.Now().Before(entry.timestamp) {
		return entry.data, true
	}
	delete(orderBookCache.cache, key) // Remove expired entry
	return nil, false
}

// Fetch order book depth with retries and caching
func fetchOrderBookDepth(srcToken, dstToken string, chainID int) ([]interface{}, error) {
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

	result, err := Retry(operation, 3, time.Second)
	if err != nil {
		return nil, err
	}
	return result.([]byte), nil
}


// REST API Handler for Route Generation
func generateRoutesHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ChainID        int64                      `json:"chainId"`
		StartToken     string                     `json:"startToken"`
		StartAmount    string                     `json:"startAmount"`
		MaxHops        int                        `json:"maxHops"`
		ProfitThreshold string                    `json:"profitThreshold"`
		TokenPrices    map[string]float64         `json:"tokenPrices"`
		Liquidity      []map[string]interface{}   `json:"liquidity"`
	}

	// Parse JSON body
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		http.Error(w, "Invalid request payload", http.StatusBadRequest)
		log.Printf("Error decoding request body: %v", err) // Keep detailed logs for debugging
		return
	}

	// Input validation
	if !common.IsHexAddress(req.StartToken) || req.ChainID <= 0 || req.MaxHops <= 0 {
		http.Error(w, "Invalid input parameters", http.StatusBadRequest)
		log.Println("Invalid input parameters detected in the request.") // Log invalid inputs
		return
	}

	startAmount := new(big.Int)
	if _, success := startAmount.SetString(req.StartAmount, 10); !success || startAmount.Cmp(big.NewInt(0)) <= 0 {
		http.Error(w, "Invalid startAmount format or value", http.StatusBadRequest)
		log.Println("Invalid startAmount format or value.") // Log invalid format or value
		return
	}

	profitThreshold := new(big.Int)
	if _, success := profitThreshold.SetString(req.ProfitThreshold, 10); !success || profitThreshold.Cmp(big.NewInt(0)) <= 0 {
		http.Error(w, "Invalid profitThreshold format or value", http.StatusBadRequest)
		log.Println("Invalid profitThreshold format or value.") // Log invalid format or value
		return
	}

	// Validate token decimals
	tokenDecimals := getTokenDecimals(req.StartToken) // Assumes a helper function exists
	if tokenDecimals < 0 {
		http.Error(w, "Unable to fetch token decimals for the start token", http.StatusBadRequest)
		log.Printf("Invalid token decimals for token: %s", req.StartToken)
		return
	}

	// Check if the start amount aligns with token decimals
	adjustedAmount := new(big.Int).Mul(startAmount, new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(tokenDecimals)), nil))
	if adjustedAmount.Cmp(big.NewInt(0)) <= 0 {
		http.Error(w, "Invalid startAmount when adjusted for token decimals", http.StatusBadRequest)
		log.Println("Invalid adjusted startAmount.") // Log invalid adjusted amount
		return
	}

	// Log received market data for debugging
	log.Printf("Received market data: TokenPrices=%v, Liquidity=%v", req.TokenPrices, req.Liquidity)

	// Compute profitable routes based on market data
	profitableRoutes, err := computeProfitableRoutes(req.TokenPrices, req.Liquidity)
	if err != nil {
		http.Error(w, "Failed to compute profitable routes", http.StatusInternalServerError)
		log.Printf("Error computing profitable routes: %v", err) // Detailed log for debugging
		return
	}

	// Further filter routes based on request parameters
	filteredRoutes, err := filterRoutes(profitableRoutes, req.ChainID, req.StartToken, adjustedAmount, req.MaxHops, profitThreshold)
	if err != nil {
		http.Error(w, "Failed to filter profitable routes", http.StatusInternalServerError)
		log.Printf("Error filtering profitable routes: %v", err) // Detailed log for debugging
		return
	}

	// Respond with the final filtered routes
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"routes": filteredRoutes,
	}); err != nil {
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
		log.Printf("Error encoding response: %v", err) // Detailed log for debugging
		return
	}

	log.Println("Successfully computed and returned filtered routes.") // Success log
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
		if route.ChainID != chainID {
			continue
		}

		if route.StartToken != strings.ToLower(startToken) {
			continue
		}

		if route.StartAmount.Cmp(startAmount) < 0 {
			continue
		}

		if route.Hops > maxHops {
			continue
		}

		if route.Profit.Cmp(profitThreshold) < 0 {
			continue
		}

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

	// Fetch stable tokens dynamically or fallback to hardcoded list
	stableTokens, err := getStableTokenList(int(chainID))
	if err != nil {
		log.Printf("Error fetching stable tokens: %v. Using fallback tokens.", err)
		stableTokens = fallbackStableTokens() // Fallback to hardcoded tokens
	}

	// Filter valid stable token addresses
	validStableTokenAddresses := filterValidAddresses(stableTokens)
	if len(validStableTokenAddresses) == 0 {
		return nil, fmt.Errorf("no valid stable token addresses available")
	}

	// Generate token pairs and build the graph using real-time data
	tokenPairs := generateTokenPairs(validStableTokenAddresses)
	graph, err := buildGraph(tokenPairs, int(chainID))
	if err != nil {
		return nil, fmt.Errorf("failed to build graph: %v", err)
	}

	// Calculate average liquidity to adjust the max hops
	averageLiquidity, err := calculateAverageLiquidity(validStableTokenAddresses, int(chainID), startToken)
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

			// Calculate profit
			profit := new(big.Int).Sub(startAmount, cost)
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
func validateEnvVars(requiredVars []string) error {
	for _, key := range requiredVars {
		value := strings.TrimSpace(os.Getenv(key))
		if value == "" {
			return fmt.Errorf("environment variable %s is not set or empty", key)
		}
	}
	return nil
}


func sendTransaction(tx Transaction, token string) (*Receipt, error) {
	// Validate required environment variables
	if err := validateEnvVars(); err != nil {
		return nil, fmt.Errorf("environment validation failed: %v", err)
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
	fromAddress := common.HexToAddress(tx.From)
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
func FetchTokenPrices(tokenAddresses []string) (map[string]float64, error) {
	if len(tokenAddresses) == 0 {
		log.Println("No token addresses provided to FetchTokenPrices.")
		return nil, nil
	}

	cacheKey := strings.Join(tokenAddresses, ",")
	if cachedData, exists := cacheGetTokenPrices(cacheKey); exists {
		log.Println("Using cached token prices.")
		return cachedData.(map[string]float64), nil
	}

	prices := make(map[string]float64)
	var wg sync.WaitGroup
	var mu sync.Mutex

	// Divide token addresses into batches
	batchSize := 4
	for i := 0; i < len(tokenAddresses); i += batchSize {
		batch := tokenAddresses[i:min(i+batchSize, len(tokenAddresses))]

		wg.Add(1)
		go func(batch []string) {
			defer wg.Done()

			url := fmt.Sprintf("https://api.1inch.dev/prices/v1.1/%s", strings.Join(batch, ","))
			headers := map[string]string{
				"Authorization": fmt.Sprintf("Bearer %s", getEnv("ONEINCH_API_KEY", "")),
				"Accept":        "application/json",
			}

			responseData, err := fetchWithRetryTokenPrices(url, headers, time.Second)
			if err != nil {
				log.Printf("Error fetching token prices for batch %v: %v", batch, err)
				return
			}

			var result map[string]float64
			if err := json.Unmarshal(responseData, &result); err != nil {
				log.Printf("Failed to parse token prices response: %v", err)
				return
			}

			mu.Lock()
			for key, value := range result {
				prices[key] = value
			}
			mu.Unlock()
		}(batch)
	}

	wg.Wait()

	// Cache the fetched prices
	cacheSetTokenPrices(cacheKey, prices, tokenPriceCacheDuration*time.Second)
	return prices, nil
}

// FetchTokenPricesAcrossProtocols fetches prices for tokens across multiple protocols
func FetchTokenPricesAcrossProtocols(tokens []string, chainID int) (map[string]map[string]interface{}, error) {
	if len(tokens) == 0 {
		log.Println("Token array is empty. Using fallback tokens...")
		tokens = hardcodedStableAddresses
	}

	prices := make(map[string]map[string]interface{})
	var wg sync.WaitGroup
	var mu sync.Mutex

	for _, token := range tokens {
		wg.Add(1)
		go func(token string) {
			defer wg.Done()

			priceData, err := FetchTokenPrices([]string{token})
			if err != nil || len(priceData) == 0 {
				log.Printf("No price data returned for %s. Skipping.", token)
				return
			}

			mu.Lock()
			prices[token] = map[string]interface{}{
				"price":    priceData[token],
				"symbol":   "UNKNOWN", // Replace with actual symbol if available
				"decimals": 18,        // Replace with actual decimals if available
			}
			mu.Unlock()
		}(token)
	}

	wg.Wait()
	return prices, nil
}

func executeRoute(route []string, CAPITAL *big.Int) error {
	const maxRetries = 3
	const initialBackoff = time.Second

	var gasPrice *big.Int
	var err error

	// Step 1: Fetch gas price
	if gasPrice, err = retryWithBackoff(maxRetries, initialBackoff, fetchGasPrice); err != nil {
		return fmt.Errorf("failed to fetch gas price: %w", err)
	}

	// Step 2: Adjust trade size
	scaledAmount, err := adjustTradeSizeForGas(CAPITAL, gasPrice)
	if err != nil {
		return fmt.Errorf("failed to adjust trade size: %w", err)
	}

	// Step 3: Approve tokens
	if err = retryWithBackoff(maxRetries, initialBackoff, func() error {
		return approveTokensNode(route, scaledAmount)
	}); err != nil {
		return fmt.Errorf("token approval failed: %w", err)
	}

	// Step 4: Construct transaction parameters
	params, err := constructParams(route, scaledAmount, nil)
	if err != nil {
		return fmt.Errorf("failed to construct transaction parameters: %w", err)
	}

	// Step 5: Estimate gas
	var gasEstimate *big.Int
	if gasEstimate, err = retryWithBackoff(maxRetries, initialBackoff, func() (*big.Int, error) {
		return estimateGas(params)
	}); err != nil {
		return fmt.Errorf("gas estimation failed: %w", err)
	}

	// Step 6: Execute transaction
	tx := Transaction{
		From:     os.Getenv("WALLET_ADDRESS"),
		To:       os.Getenv("CONTRACT_ADDRESS"),
		Data:     params,
		Gas:      gasEstimate,
		GasPrice: gasPrice,
	}

	var receipt *Receipt
	if receipt, err = retryWithBackoff(maxRetries, initialBackoff, func() (*Receipt, error) {
		return sendTransaction(tx)
	}); err != nil {
		notifyNode("execution_error", fmt.Sprintf("Error executing route: %v", err))
		return fmt.Errorf("transaction execution failed: %w", err)
	}

	notifyNode("execution_success", fmt.Sprintf("Route executed: %v, TxHash: %s", route, receipt.TransactionHash))
	log.Printf("Transaction successful. Hash: %s", receipt.TransactionHash)
	return nil
}

// retryWithBackoff retries a function with exponential backoff.
func retryWithBackoff[T any](maxRetries int, initialBackoff time.Duration, fn func() (T, error)) (T, error) {
	var result T
	var err error
	backoff := initialBackoff

	for attempt := 1; attempt <= maxRetries; attempt++ {
		result, err = fn()
		if err == nil {
			return result, nil
		}

		log.Printf("Retry attempt %d/%d failed: %v", attempt, maxRetries, err)
		time.Sleep(backoff)
		backoff *= 2
	}

	return result, fmt.Errorf("all retries failed: %w", err)
}


// Helper function to set cache with expiration for token prices
func cacheSetTokenPrices(key string, value interface{}, duration time.Duration) {
	tokenPriceCache.mu.Lock()
	defer tokenPriceCache.mu.Unlock()
	tokenPriceCache.cache[key] = CacheEntry{
		data:      value,
		timestamp: time.Now().Add(duration),
	}
}

// Helper function to get cache for token prices
func cacheGetTokenPrices(key string) (interface{}, bool) {
	tokenPriceCache.mu.Lock()
	defer tokenPriceCache.mu.Unlock()
	entry, exists := tokenPriceCache.cache[key]
	if exists && time.Now().Before(entry.timestamp) {
		return entry.data, true
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
        // Validate source and destination token addresses
        if !common.IsHexAddress(pair.SrcToken) || !common.IsHexAddress(pair.DstToken) {
            log.Printf("Skipping invalid token pair: %s -> %s", pair.SrcToken, pair.DstToken)
            continue
        }

        // Fetch token prices and liquidity
        price, liquidity, err := fetchTokenPairData(pair.SrcToken, pair.DstToken, chainID)
        if err != nil {
            log.Printf("Error fetching data for pair %s -> %s: %v", pair.SrcToken, pair.DstToken, err)
            continue
        }

        // Compute edge weight based on adjustable metrics
        weight := calculateWeight(price, liquidity)

        if graph.AdjacencyList[pair.SrcToken] == nil {
            graph.AdjacencyList[pair.SrcToken] = make(map[string]EdgeWeight)
        }

        // Add weighted edge to the graph
        graph.AdjacencyList[pair.SrcToken][pair.DstToken] = EdgeWeight{
            Weight:    weight,
            Liquidity: liquidity,
        }

        log.Printf("Edge added: %s -> %s, Weight: %f, Liquidity: %f",
            pair.SrcToken, pair.DstToken, weight, liquidity)
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
	// Fetch token prices
	prices, err := FetchTokenPrices([]string{srcToken, dstToken})
	if err != nil {
		return nil, nil, fmt.Errorf("failed to fetch token prices: %v", err)
	}

	srcPrice, srcExists := prices[srcToken]
	dstPrice, dstExists := prices[dstToken]
	if !srcExists || !dstExists {
		return nil, nil, fmt.Errorf("missing price data for token pair %s -> %s", srcToken, dstToken)
	}

      if srcPrice, ok := prices[srcToken]; !ok {
                return nil, nil, fmt.Errorf("missing price data for source token: %s", srcToken)
      }
	// Estimate liquidity
	liquidity, err := estimateLiquidity(chainID, srcToken, dstToken)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to estimate liquidity for pair %s -> %s: %v", srcToken, dstToken, err)
	}

	// Calculate price ratio
	priceRatio := new(big.Float).Quo(big.NewFloat(srcPrice), big.NewFloat(dstPrice))
	return priceRatio, liquidity, nil
}


func calculateAverageLiquidity(tokens []string, chainID int, startToken string) (*big.Float, error) {
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

func estimateLiquidity(chainID int, srcToken, dstToken string) (*big.Float, error) {
	// Fetch the order book using fetchOrderBookDepth
	orderBook, err := fetchOrderBookDepth(srcToken, dstToken, chainID)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch order book for %s -> %s: %v", srcToken, dstToken, err)
	}

	if len(orderBook) == 0 {
		return nil, fmt.Errorf("no orders available for %s -> %s", srcToken, dstToken)
	}

	// Extract liquidity data from the order book
	totalLiquidity := orderBookLiquidity(orderBook)
	if totalLiquidity.Cmp(big.NewFloat(0)) <= 0 {
		return nil, fmt.Errorf("invalid total liquidity for %s -> %s", srcToken, dstToken)
	}

	// Binary search to find the best amount
	low := big.NewFloat(1e18) // Minimum trade size
	high := big.NewFloat(1e24)
	bestAmount := new(big.Float).Set(low)

	for low.Cmp(high) <= 0 {
		mid := new(big.Float).Add(low, high).Quo(new(big.Float).Add(low, high), big.NewFloat(2))

		adjustedAmount, err := adjustForSlippage(mid, totalLiquidity)
		if err != nil {
			log.Printf("Slippage adjustment failed for %s -> %s at amount %s: %v", srcToken, dstToken, mid.String(), err)
			high.Sub(mid, big.NewFloat(1))
			continue
		}

		if adjustedAmount.Cmp(big.NewFloat(0)) > 0 {
			bestAmount.Set(mid)
			low.Add(mid, big.NewFloat(1))
		} else {
			high.Sub(mid, big.NewFloat(1))
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

// // EstimateLiquidity estimates the maximum liquidity for a trading pair
// func estimateLiquidity(chainID int64, srcToken, dstToken string) (*big.Int, error) {
// 	orderBook, err := fetchOrderBookDepth(srcToken, dstToken)
// 	if err != nil || orderBook.Liquidity == nil {
// 		return nil, errors.New("liquidity data unavailable for " + srcToken + " ➡️ " + dstToken)
// 	}

// 	// Set binary search range
// 	low := big.NewInt(1e18)   // 1 token (scaled to 18 decimals)
// 	high := big.NewInt(1e24)  // 1 million tokens (scaled to 18 decimals)
// 	bestAmount := new(big.Int).Set(low)

// 	for low.Cmp(high) <= 0 {
// 		mid := new(big.Int).Add(low, high)
// 		mid.Div(mid, big.NewInt(2)) // mid = (low + high) / 2

// 		// Adjust for slippage
// 		adjustedAmount, err := adjustForSlippage(big.NewFloat(0).SetInt(mid), orderBook.Liquidity)
// 		if err != nil {
// 			log.Printf("Liquidity estimation failed: %v", err)
// 			high.Sub(mid, big.NewInt(1)) // Move the upper bound down
// 			continue
// 		}

// 		if adjustedAmount.Cmp(big.NewFloat(0)) > 0 { // If adjustedAmount > 0
// 			bestAmount.Set(mid)       // Update the best amount
// 			low.Add(mid, big.NewInt(1)) // Move the lower bound up
// 		} else {
// 			high.Sub(mid, big.NewInt(1)) // Move the upper bound down
// 		}
// 	}

// 	return bestAmount, nil
// }


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

// func BuildGraph(tokenPairs []TokenPair, chainID int64) (Graph, error) {
// 	graph := make(Graph)

// 	for _, pair := range tokenPairs {
// 		orders, err := fetchOrderBookDepth(pair.SrcToken, pair.DstToken, int(chainID))
// 		if err != nil {
// 			log.Printf("Error fetching order book for %s -> %s: %v", pair.SrcToken, pair.DstToken, err)
// 			continue
// 		}

// 		if len(orders) == 0 {
// 			log.Printf("No orders found for %s -> %s. Skipping.", pair.SrcToken, pair.DstToken)
// 			continue
// 		}

// 		bestOrder, err := findBestOrder(orders)
// 		if err != nil {
// 			log.Printf("Error finding best order for %s -> %s: %v", pair.SrcToken, pair.DstToken, err)
// 			continue
// 		}

// 		// Calculate the weight (e.g., price or inverse liquidity)
// 		makingAmount := bestOrder["makingAmount"].(float64) // Replace with actual parsing logic
// 		takingAmount := bestOrder["takingAmount"].(float64)
// 		weight := takingAmount / makingAmount

// 		if _, exists := graph[pair.SrcToken]; !exists {
// 			graph[pair.SrcToken] = make(map[string]float64)
// 		}
// 		graph[pair.SrcToken][pair.DstToken] = weight

// 		log.Printf("Edge added: %s -> %s, weight: %f", pair.SrcToken, pair.DstToken, weight)
// 	}

// 	return graph, nil
// }


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
	log.Printf("Unknown transaction targeting contract: %s", toAddress.Hex())
}

// Process Uniswap-specific transactions
func processUniswapTransaction(methodName string, args map[string]interface{}) {
	switch methodName {
	case "exactInput":
		params := args["params"].(map[string]interface{})
		path := params["path"].([]byte) // Multi-hop path as a byte array
		decodedPath := decodePath(path) // Decode path to token addresses
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
	const addressLength = 20 // Each token address is 20 bytes

	// Validate that the path is not nil or empty
	if path == nil || len(path) == 0 {
		return nil, fmt.Errorf("path is empty or nil")
	}

	// Validate that the length of the path is a multiple of the address length
	if len(path)%addressLength != 0 {
		return nil, fmt.Errorf("invalid path length: %d (must be a multiple of %d)", len(path), addressLength)
	}

	decodedPath := []string{}

	// Decode each 20-byte chunk as a token address
	for i := 0; i+addressLength <= len(path); i += addressLength {
		tokenBytes := path[i : i+addressLength]

		// Validate that the bytes can form a valid Ethereum address
		token := common.BytesToAddress(tokenBytes)
		if !common.IsHexAddress(token.Hex()) {
			return nil, fmt.Errorf("invalid token address at chunk %d: %x", i/addressLength, tokenBytes)
		}

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
// Wrapper function to retry mempool monitoring with graceful shutdown
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

// Main function for monitoring mempool with retryable connection and subscription logic
func monitorMempool(ctx context.Context, targetContracts map[string]bool, rpcURL string) error {
	// Retry logic for connecting to Ethereum client
	clientResult, err := Retry(func() (interface{}, error) {
		return ethclient.Dial(rpcURL)
	}, 3, 2*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect to Ethereum client after retries: %v", err)
	}

	client := clientResult.(*ethclient.Client)
	defer client.Close()
	log.Println("Connected to Ethereum client. Monitoring mempool...")

	for {
		// Retry logic for subscribing to pending transactions
		subResult, err := Retry(func() (interface{}, error) {
			pendingTxs := make(chan *types.Transaction)
			sub, err := client.SubscribePendingTransactions(ctx, pendingTxs)
			if err != nil {
				return nil, err
			}
			return struct {
				Sub       ethereum.Subscription
				PendingTx chan *types.Transaction
			}{Sub: sub, PendingTx: pendingTxs}, nil
		}, 3, 2*time.Second)
		if err != nil {
			log.Printf("Failed to subscribe to pending transactions after retries: %v", err)
			time.Sleep(5 * time.Second) // Delay before retrying the entire loop
			continue
		}

		subscriptionData := subResult.(struct {
			Sub       ethereum.Subscription
			PendingTx chan *types.Transaction
		})
		sub := subscriptionData.Sub
		pendingTxs := subscriptionData.PendingTx

		// Process transactions as they arrive
		for {
			select {
			case err := <-sub.Err():
				log.Printf("Subscription error: %v. Retrying subscription...", err)
				sub.Unsubscribe()
				break // Exit the inner loop to retry subscription
			case tx := <-pendingTxs:
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

	// Build call message
	callMsg := ethereum.CallMsg{
		From: common.HexToAddress(os.Getenv("WALLET_ADDRESS")),
		To:   common.HexToAddress(os.Getenv("CONTRACT_ADDRESS")),
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
		log.Printf("Failed to upgrade to WebSocket: %v", err)
		return
	}

	// Extract or generate session ID
	sessionID := r.URL.Query().Get("sessionID")
	if sessionID == "" {
		sessionID = generateSessionID() // Generate a unique session ID
	}

	// Check for existing session
	sessionMutex.Lock()
	session, exists := wsSessions[sessionID]
	if exists {
		// Reuse the existing session
		log.Printf("Reconnected to session %s", sessionID)
		session.Client.Conn.Close() // Close old connection
		session.Client.Conn = conn
		session.Client.Context, session.Client.CancelFunc = context.WithCancel(context.Background())
	} else {
		// Create a new session
		client := &WebSocketClient{Conn: conn, Context: context.WithCancel(context.Background())}
		session = &WebSocketSession{
			SessionID: sessionID,
			Client:    client,
			State:     make(map[string]interface{}),
		}
		wsSessions[sessionID] = session
		log.Printf("New session created: %s", sessionID)
	}
	sessionMutex.Unlock()

	// Handle client messages
	go handleClientMessages(session.Client)

	// Send session ID to the client
	if err := conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf(`{"sessionID":"%s"}`, sessionID))); err != nil {
		log.Printf("Failed to send session ID: %v", err)
	}
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
			broadcastChannel <- string(message)
		}
	}
}

func shutdownWebSocketServer() {
	clientsMutex.Lock()
	defer clientsMutex.Unlock()

	log.Println("Shutting down WebSocket server. Closing all client connections...")

	for client := range wsClients {
		client.CancelFunc() // Signal all client contexts to cancel
		client.Conn.Close() // Close WebSocket connection
		delete(wsClients, client)
	}

	log.Println("All client connections closed.")
}

func monitorSystemHealth() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		// Log active WebSocket clients and goroutines
		clientsMutex.Lock()
		activeClients := len(wsClients)
		clientsMutex.Unlock()
		log.Printf("System Health: Active WebSocket Clients: %d, Active Goroutines: %d",
			activeClients, runtime.NumGoroutine())

		// Log memory usage
		logMemoryUsage()

		// Log API rate limits
		logAPILimits()
	}
}

func cleanupInactiveClients() {
	clientsMutex.Lock()
	defer clientsMutex.Unlock()

	for client := range wsClients {
		if client.Context.Err() != nil { // Check if the context is done
			log.Printf("Removing inactive WebSocket client.")
			client.Conn.Close()
			delete(wsClients, client)
		}
	}
}

// Handle messages from a WebSocket client
func handleMessages(client *WebSocketClient) {
	defer func() {
		clientsMutex.Lock()
		delete(wsClients, client)
		clientsMutex.Unlock()
		client.RateLimiter.Stop() // Stop rate limiter for this client
		client.Conn.Close()
		log.Println("WebSocket client disconnected.")
	}()

	for {
		_, message, err := client.Conn.ReadMessage()
		if err != nil {
			log.Printf("Error reading message: %v", err)
			client.Disconnected <- true
			return
		}

		if !client.RateLimiter.Allow() {
			log.Println("Rate limit exceeded. Dropping message.")
			continue
		}

		// Broadcast the received message to the channel
		broadcastChannel <- string(message)
	}
}

// Broadcast messages to all WebSocket clients
func broadcastMessages() {
	for message := range broadcastChannel {
		clientsMutex.Lock()

		// Iterate over all clients and send messages
		for client := range wsClients {
			err := client.Conn.WriteMessage(websocket.TextMessage, message)
			if err != nil {
				log.Printf("Error broadcasting to client: %v. Removing client.", err)
				client.Conn.Close()
				delete(wsClients, client) // Remove stale client
			}
		}

		clientsMutex.Unlock()
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

        for client := range wsClients {
            func(client *websocket.Conn) {
                defer func() {
                    if r := recover(); r != nil {
                        log.Printf("Recovered from panic while sending WebSocket message: %v", r)
                        client.Close()
                        delete(wsClients, client)
                    }
                }()

                // Attempt to send the message to the WebSocket client
                err := client.WriteMessage(websocket.TextMessage, data)
                if err != nil {
                    log.Printf("WebSocket send error: %v", err)
                    client.Close()
                    delete(wsClients, client)
                }
            }(client)
        }
    }
}


// Main function
func main() {
	// Required environment variables
	requiredVars := []string{
		"INFURA_WS_URL",     // WebSocket RPC URL for Ethereum
		"NODE_API_URL",      // API endpoint for token approvals
		"RPC_URL",           // RPC URL for Ethereum client
		"PRIVATE_KEY",       // Private key for signing transactions
		"WALLET_ADDRESS",    // Address of the wallet
		"CONTRACT_ADDRESS",  // Address of the contract
	}

	// Validate environment variables
	if err := validateEnvVars(requiredVars); err != nil {
		log.Fatalf("Environment validation failed: %v", err)
	}

	// Fetch and use validated variables
	rpcURL := os.Getenv("INFURA_WS_URL")
	nodeAPIURL := os.Getenv("NODE_API_URL")

	// Parse Uniswap and SushiSwap ABIs
	uniswapABI, err := abi.JSON(strings.NewReader(UniswapV3RouterABI))
	if err != nil {
		log.Fatalf("Failed to parse Uniswap V3 Router ABI: %v", err)
	}

	sushiSwapABI, err := abi.JSON(strings.NewReader(SushiSwapRouterABI))
	if err != nil {
		log.Fatalf("Failed to parse SushiSwap Router ABI: %v", err)
	}

	// Define target contracts
	targetContracts := map[string]bool{
		"0xE592427A0AEce92De3Edee1F18E0157C05861564": true, // Uniswap V3
		"0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F": true, // SushiSwap
	}

       // Graceful shutdown handling
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		c := make(chan os.Signal, 1)
		signal.Notify(c, os.Interrupt, syscall.SIGTERM)
		<-c
		log.Println("Received shutdown signal, initiating cleanup...")
		cancel()           // Signal goroutines to stop
		shutdownWebSocketServer() // Cleanup WebSocket server
	}()

	// Start WebSocket server
	http.HandleFunc("/ws", wsHandler)
	go func() {
		log.Println("WebSocket server listening on :8080/ws")
		log.Fatal(http.ListenAndServe(":8080", nil))
	}()

	// Start monitoring the mempool in a separate goroutine
	// Monitor mempool in a separate goroutine with retry logic
	go func() {
		if err := monitorMempoolWithRetry(ctx, targetContracts, os.Getenv("INFURA_WS_URL")); err != nil {
			log.Printf("Mempool monitoring terminated: %v", err)
			cancel() // Trigger shutdown on failure
		}
	}()

	// Start the REST API server for route generation and dynamic graph building
	http.HandleFunc("/generate-routes", func(w http.ResponseWriter, r *http.Request) {
		// Example REST API handler logic
		chainID := int64(42161) // Ethereum Mainnet
		startToken := "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" // USDC address

		dstToken := r.URL.Query().Get("dstToken")
		if !isValidTokenAddress(dstToken) {
			http.Error(w, "Invalid destination token address", http.StatusBadRequest)
			return
		}

		tokenPairs := []TokenPair{
			{SrcToken: startToken, DstToken: dstToken},
		}

		graph, err := BuildGraph(tokenPairs, chainID)
		if err != nil {
			log.Printf("Error building graph: %v", err)
			http.Error(w, "Failed to build graph", http.StatusInternalServerError)
			return
		}

		path, cost, err := ComputeOptimalRoute(graph, startToken, dstToken)
		if err != nil {
			log.Printf("Error computing optimal route: %v", err)
			http.Error(w, "Failed to compute optimal route", http.StatusInternalServerError)
			return
		}

		log.Printf("Optimal route: %v, Total cost: %f", path, cost)
		w.Header().Set("Content-Type", "application/json")
		response := map[string]interface{}{
			"path": path,
			"cost": cost,
		}
		json.NewEncoder(w).Encode(response)
	})

     // Monitor system health periodically
	go monitorSystemHealth()
    
       shutdownAll(ctx)
	// Final log before starting HTTP server
	log.Println("Starting HTTP server on :8080...")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

// Helper function to validate token address
func isValidTokenAddress(address string) bool {
	// Replace with your token address validation logic (e.g., regex or lookup)
	return len(address) == 42 && address[:2] == "0x"
}
