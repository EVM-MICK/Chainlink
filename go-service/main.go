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
)

type ArbitrageOpportunity struct {
	TxHash   string  `json:"txHash"`
	Profit   string  `json:"profit"`
	SrcToken string  `json:"srcToken"`
	DstToken string  `json:"dstToken"`
	AmountIn string  `json:"amountIn"`
}

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

type Receipt struct {
	TransactionHash string `json:"transactionHash"`
}


// WebSocket connection manager
var wsClients = make(map[*websocket.Conn]bool)
// Global shared Ethereum client
var sharedClient *ethclient.Client
var clientOnce sync.Once
// Global WebSocket Broadcast Channel
var wsBroadcast = make(chan ArbitrageOpportunity)
// Hardcoded stable token addresses
var hardcodedStableTokens = []Token{
	{"0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "USDT", 6, "Tether USD"},
	{"0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "USDC", 6, "USD Coin"},
	{"0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", "DAI", 18, "Dai Stablecoin"},
	{"0x82af49447d8a07e3bd95bd0d56f35241523fbab1", "WETH", 18, "Wrapped Ether"},
	{"0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", "WBTC", 8, "Wrapped Bitcoin"},
}


// Global cache instance for stable token data
var stableTokenCache = cache.New(10*time.Minute, 15*time.Minute) // Default expiration and cleanup interval


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
type Graph map[string]map[string]float64

var tokenPriceCache = TokenPriceCache{
	cache: make(map[string]CacheEntry),
}

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

var orderBookCache = OrderBookCache{
	cache: make(map[string]CacheEntry),
}

// Cache duration in seconds
const cacheDuration = 600 // 10 minutes

// Cache structure to store quotes
type QuoteCache struct {
	mu    sync.Mutex
	cache map[string]interface{}
}

var quoteCache = QuoteCache{
	cache: make(map[string]interface{}),
}


var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}


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
	CAPITAL                 = big.NewInt(100000000000000000000000) // $100,000 in USDC (6 decimals)
	MINIMUM_PROFIT_THRESHOLD = big.NewInt(500000000000000000)      // $500 in USDC (6 decimals)
	FLASHLOAN_FEE_RATE       = big.NewFloat(0.0009)               // 0.09% fee
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
	setToStableTokenCache(cacheKey, stableTokens, stableTokenCache)
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

func setToStableTokenCache(key string, value interface{}, duration time.Duration) {
	// Add entry to go-cache with a specific expiration duration
	stableTokenCache.Set(key, value, duration)
	log.Printf("Added key: %s to cache with expiration: %v", key, duration)
}

// Callback for cache expiration (optional but useful for debugging)
func setupCacheExpirationLogging() {
	stableTokenCache.OnEvicted(func(key string, value interface{}) {
		log.Printf("Cache entry expired for key: %s", key)
	})
}

// Initialize the cache with expiration logging
func init() {
	setupCacheExpirationLogging()
}

func setToStableTokenCache(key string, value interface{}, duration time.Duration) {
	stableTokenCache.mu.Lock()
	defer stableTokenCache.mu.Unlock()
	stableTokenCache.cache[key] = CacheEntry{
		data:      value,
		timestamp: time.Now().Add(duration),
	}
}


// Pop removes and returns the node with the highest priority
func (pq *PriorityQueue) Pop() interface{} {
	old := *pq
	n := len(old)
	node := old[n-1]
	old[n-1] = nil // Avoid memory leak
	node.Index = -1
	*pq = old[0 : n-1]
	return node
}

// Update modifies the priority of a node in the queue
func (pq *PriorityQueue) Update(node *Node, priority float64) {
	node.Priority = priority
	heap.Fix(pq, node.Index)
}

// ComputeOptimalRoute finds the optimal route using Dijkstra's algorithm
func ComputeOptimalRoute(graph Graph, startToken, endToken string) ([]string, float64, error) {
	if _, exists := graph[startToken]; !exists {
		return nil, math.Inf(1), fmt.Errorf("start token %s not found in the graph", startToken)
	}
	if _, exists := graph[endToken]; !exists {
		return nil, math.Inf(1), fmt.Errorf("end token %s not found in the graph", endToken)
	}

	// Initialize distances and previous nodes
	distances := make(map[string]float64)
	previous := make(map[string]string)
	for token := range graph {
		distances[token] = math.Inf(1)
	}
	distances[startToken] = 0

	// Initialize the priority queue
	pq := make(PriorityQueue, 0)
	heap.Init(&pq)
	heap.Push(&pq, &Node{Token: startToken, Priority: 0})

	visited := make(map[string]bool)

	// Dijkstra's algorithm
	for pq.Len() > 0 {
		current := heap.Pop(&pq).(*Node)
		currentToken := current.Token

		if visited[currentToken] {
			continue
		}
		visited[currentToken] = true

		// If we reach the end token, construct the path
		if currentToken == endToken {
			path := []string{}
			for token := endToken; token != ""; token = previous[token] {
				path = append([]string{token}, path...)
			}
			return path, distances[endToken], nil
		}

		// Explore neighbors
		for neighbor, weight := range graph[currentToken] {
			if visited[neighbor] {
				continue
			}

			newDistance := distances[currentToken] + weight
			if newDistance < distances[neighbor] {
				distances[neighbor] = newDistance
				previous[neighbor] = currentToken
				heap.Push(&pq, &Node{Token: neighbor, Priority: newDistance})
			}
		}
	}

	// No path found
	return nil, math.Inf(1), nil
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
		hopGasCost := new(big.Float).Mul(gasPrice, big.NewFloat(800000)) // Adjust gas per hop if needed
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
	estimatedGas := big.NewFloat(800000) // Replace with dynamic estimate
	gasCost := new(big.Float).Mul(gasPrice, estimatedGas)

	flashLoanFee := new(big.Float).Mul(new(big.Float).SetInt(CAPITAL), big.NewFloat(0.0005)) // 0.05% fee
	dynamicThreshold := new(big.Float).Add(new(big.Float).SetInt(MINIMUM_PROFIT_THRESHOLD), gasCost)
	dynamicThreshold.Add(dynamicThreshold, flashLoanFee)

	result := new(big.Int)
	dynamicThreshold.Int(result)
	return result, nil
}

// Helper to set a value in the cache
func setToCache(key string, value interface{}) {
	quoteCache.mu.Lock()
	defer quoteCache.mu.Unlock()
	quoteCache.cache[key] = value
}

// Helper to get a value from the cache
func getFromCache(key string) (interface{}, bool) {
	quoteCache.mu.Lock()
	defer quoteCache.mu.Unlock()
	value, exists := quoteCache.cache[key]
	return value, exists
}

// Helper function for exponential backoff retries
func fetchWithRetries(url string, headers map[string]string, maxRetries int, backoff time.Duration) ([]byte, error) {
	var err error
	for attempt := 1; attempt <= maxRetries; attempt++ {
		req, reqErr := http.NewRequest("GET", url, nil)
		if reqErr != nil {
			return nil, fmt.Errorf("failed to create request: %v", reqErr)
		}
		for key, value := range headers {
			req.Header.Set(key, value)
		}

		client := &http.Client{}
		resp, respErr := client.Do(req)
		if respErr != nil {
			err = respErr
			log.Printf("Error fetching data (attempt %d): %v", attempt, respErr)
		} else {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return ioutil.ReadAll(resp.Body)
			}

			if resp.StatusCode == 429 && attempt < maxRetries {
				log.Printf("Rate limit hit. Retrying in %v... (Attempt %d/%d)", backoff, attempt, maxRetries)
				time.Sleep(backoff)
				backoff *= 2 // Exponential backoff
			} else {
				body, _ := ioutil.ReadAll(resp.Body)
				return nil, fmt.Errorf("error fetching data: %s", string(body))
			}
		}
	}
	return nil, fmt.Errorf("failed to fetch data after %d attempts: %v", maxRetries, err)
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

	maxRetries := 3
	backoff := time.Second

	// Retry logic with exponential backoff
	for attempt := 1; attempt <= maxRetries; attempt++ {
		log.Printf("Fetching order book for %s -> %s on chain %d (Attempt %d)...", srcToken, dstToken, chainID, attempt)

		responseData, err := fetchWithRetryOrderBook(url, headers, params, backoff)
		if err != nil {
			log.Printf("Error fetching order book for %s -> %s: %v", srcToken, dstToken, err)
			if attempt == maxRetries {
				return nil, fmt.Errorf("max retries reached for %s -> %s: %v", srcToken, dstToken, err)
			}
			time.Sleep(backoff)
			backoff *= 2 // Exponential backoff
			continue
		}

		// Parse response
		var result struct {
			Orders []interface{} `json:"orders"`
		}
		if err := json.Unmarshal(responseData, &result); err != nil {
			return nil, fmt.Errorf("failed to parse order book response: %v", err)
		}

		if len(result.Orders) == 0 {
			log.Printf("No orders found for %s -> %s", srcToken, dstToken)
			return nil, nil
		}

		// Cache and return the result
		log.Printf("Order book fetched successfully for %s -> %s", srcToken, dstToken)
		cacheSetOrderBook(cacheKey, result.Orders, cacheDuration*time.Second)
		return result.Orders, nil
	}

	return nil, fmt.Errorf("failed to fetch order book for %s -> %s after %d attempts", srcToken, dstToken, maxRetries)
}

// Helper function for HTTP GET with retries and parameters
func fetchWithRetryOrderBook(url string, headers, params map[string]string, backoff time.Duration) ([]byte, error) {
	client := &http.Client{}
	queryParams := "?"
	for key, value := range params {
		queryParams += fmt.Sprintf("%s=%s&", key, value)
	}
	url += queryParams[:len(queryParams)-1] // Remove trailing '&'

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

// REST API Handler for Route Generation
func generateRoutesHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ChainID       int64  `json:"chainId"`
		StartToken    string `json:"startToken"`
		StartAmount   string `json:"startAmount"`
		MaxHops       int    `json:"maxHops"`
		ProfitThreshold string `json:"profitThreshold"`
	}

	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	startAmount := new(big.Int)
	startAmount.SetString(req.StartAmount, 10)

	profitThreshold := new(big.Int)
	profitThreshold.SetString(req.ProfitThreshold, 10)

	routes, err := generateRoutes(req.ChainID, req.StartToken, startAmount, req.MaxHops, profitThreshold)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(routes)
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
		log.Println("Using cached gas price.")
		gasPriceCache.RUnlock()
		return gasPriceCache.price, nil
	}
	gasPriceCache.RUnlock()

	// Retry logic
	const maxRetries = 3
	const retryDelay = 1 * time.Second
	var gasPriceGwei float64

	for i := 0; i < maxRetries; i++ {
		resp, err := http.Get("https://api.blocknative.com/gasprices/blockprices")
		if err != nil {
			log.Printf("Error fetching gas price (attempt %d/%d): %v", i+1, maxRetries, err)
			time.Sleep(retryDelay)
			continue
		}
		defer resp.Body.Close()

		// Parse the response
		var result struct {
			BlockPrices []struct {
				BaseFeePerGas float64 `json:"baseFeePerGas"`
			} `json:"blockPrices"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			log.Printf("Error decoding gas price response: %v", err)
			time.Sleep(retryDelay)
			continue
		}

		if len(result.BlockPrices) > 0 {
			gasPriceGwei = result.BlockPrices[0].BaseFeePerGas
			break
		}
	}

	// If fetching fails, use a fallback value
	if gasPriceGwei == 0 {
		log.Println("Gas price API failed. Using fallback value: 50 Gwei.")
		gasPriceGwei = 50
	}

	// Convert Gwei to Wei
	gasPriceWei := new(big.Int).Mul(big.NewInt(int64(gasPriceGwei)), big.NewInt(1e9))

	// Update the cache
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

// Validate environment variables at startup
func validateEnvVars() error {
	requiredVars := []string{"RPC_URL", "PRIVATE_KEY"}
	for _, v := range requiredVars {
		if os.Getenv(v) == "" {
			return fmt.Errorf("environment variable %s is not set", v)
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

	// Step 1: Fetch the current gas price with retry logic
	var gasPrice *big.Int
	var err error
	for attempt := 1; attempt <= maxRetries; attempt++ {
		gasPrice, err = fetchGasPrice()
		if err == nil {
			break
		}
		log.Printf("Failed to fetch gas price (attempt %d/%d): %v", attempt, maxRetries, err)
		time.Sleep(initialBackoff * time.Duration(attempt)) // Exponential backoff
	}
	if err != nil {
		return fmt.Errorf("failed to fetch gas price after %d attempts: %v", maxRetries, err)
	}

	// Step 2: Adjust the trade size based on gas cost
	scaledAmount, err := adjustTradeSizeForGas(CAPITAL, gasPrice)
	if err != nil {
		return fmt.Errorf("failed to adjust trade size: %v", err)
	}

	// Step 3: Approve tokens via Node.js API with retry logic
	for attempt := 1; attempt <= maxRetries; attempt++ {
		err = approveTokensNode(route, scaledAmount)
		if err == nil {
			break
		}
		log.Printf("Token approval failed (attempt %d/%d): %v", attempt, maxRetries, err)
		time.Sleep(initialBackoff * time.Duration(attempt)) // Exponential backoff
	}
	if err != nil {
		return fmt.Errorf("token approval failed after %d attempts: %v", maxRetries, err)
	}

	// Step 4: Construct transaction calldata and estimate gas
	params, err := constructParams(route, scaledAmount, nil)
	if err != nil {
		return fmt.Errorf("failed to construct transaction parameters: %v", err)
	}

	var gasEstimate *big.Int
	for attempt := 1; attempt <= maxRetries; attempt++ {
		gasEstimate, err = estimateGas(params)
		if err == nil {
			break
		}
		log.Printf("Gas estimation failed (attempt %d/%d): %v", attempt, maxRetries, err)
		time.Sleep(initialBackoff * time.Duration(attempt)) // Exponential backoff
	}
	if err != nil {
		return fmt.Errorf("gas estimation failed after %d attempts: %v", maxRetries, err)
	}

	// Step 5: Execute transaction with retry logic
	tx := Transaction{
		From:     os.Getenv("WALLET_ADDRESS"),
		To:       os.Getenv("CONTRACT_ADDRESS"),
		Data:     params,
		Gas:      gasEstimate,
		GasPrice: gasPrice,
	}

	var receipt *Receipt
	for attempt := 1; attempt <= maxRetries; attempt++ {
		receipt, err = sendTransaction(tx)
		if err == nil {
			break
		}
		log.Printf("Transaction execution failed (attempt %d/%d): %v", attempt, maxRetries, err)
		time.Sleep(initialBackoff * time.Duration(attempt)) // Exponential backoff
	}
	if err != nil {
		notifyNode("execution_error", fmt.Sprintf("Error executing route after %d attempts: %v", maxRetries, err))
		return fmt.Errorf("transaction failed after %d attempts: %v", maxRetries, err)
	}

	// Step 6: Notify Node.js for successful execution
	notifyNode("execution_success", fmt.Sprintf("Route executed: %v, TxHash: %s", route, receipt.TransactionHash))

	log.Printf("Transaction successful. Hash: %s", receipt.TransactionHash)
	return nil
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

func buildGraph(tokenPairs []TokenPair, chainID int64) (*Graph, error) {
	// Mock implementation. Replace with logic to fetch graph data.
	graph := &Graph{AdjacencyList: make(map[string]map[string]*big.Float)}
	for _, pair := range tokenPairs {
		if graph.AdjacencyList[pair.SrcToken] == nil {
			graph.AdjacencyList[pair.SrcToken] = make(map[string]*big.Float)
		}
		graph.AdjacencyList[pair.SrcToken][pair.DstToken] = big.NewFloat(1.0) // Example weight
	}
	return graph, nil
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

// EstimateLiquidity estimates the maximum liquidity for a trading pair
func estimateLiquidity(chainID int64, srcToken, dstToken string) (*big.Int, error) {
	orderBook, err := fetchOrderBookDepth(srcToken, dstToken)
	if err != nil || orderBook.Liquidity == nil {
		return nil, errors.New("liquidity data unavailable for " + srcToken + " ➡️ " + dstToken)
	}

	// Set binary search range
	low := big.NewInt(1e18)   // 1 token (scaled to 18 decimals)
	high := big.NewInt(1e24)  // 1 million tokens (scaled to 18 decimals)
	bestAmount := new(big.Int).Set(low)

	for low.Cmp(high) <= 0 {
		mid := new(big.Int).Add(low, high)
		mid.Div(mid, big.NewInt(2)) // mid = (low + high) / 2

		// Adjust for slippage
		adjustedAmount, err := adjustForSlippage(big.NewFloat(0).SetInt(mid), orderBook.Liquidity)
		if err != nil {
			log.Printf("Liquidity estimation failed: %v", err)
			high.Sub(mid, big.NewInt(1)) // Move the upper bound down
			continue
		}

		if adjustedAmount.Cmp(big.NewFloat(0)) > 0 { // If adjustedAmount > 0
			bestAmount.Set(mid)       // Update the best amount
			low.Add(mid, big.NewInt(1)) // Move the lower bound up
		} else {
			high.Sub(mid, big.NewInt(1)) // Move the upper bound down
		}
	}

	return bestAmount, nil
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
	estimatedGasCost := new(big.Int).Mul(gasPrice, big.NewInt(800000)) // Estimate: 800k gas units
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

func BuildGraph(tokenPairs []TokenPair, chainID int64) (Graph, error) {
	graph := make(Graph)

	for _, pair := range tokenPairs {
		orders, err := fetchOrderBookDepth(pair.SrcToken, pair.DstToken, int(chainID))
		if err != nil {
			log.Printf("Error fetching order book for %s -> %s: %v", pair.SrcToken, pair.DstToken, err)
			continue
		}

		if len(orders) == 0 {
			log.Printf("No orders found for %s -> %s. Skipping.", pair.SrcToken, pair.DstToken)
			continue
		}

		bestOrder, err := findBestOrder(orders)
		if err != nil {
			log.Printf("Error finding best order for %s -> %s: %v", pair.SrcToken, pair.DstToken, err)
			continue
		}

		// Calculate the weight (e.g., price or inverse liquidity)
		makingAmount := bestOrder["makingAmount"].(float64) // Replace with actual parsing logic
		takingAmount := bestOrder["takingAmount"].(float64)
		weight := takingAmount / makingAmount

		if _, exists := graph[pair.SrcToken]; !exists {
			graph[pair.SrcToken] = make(map[string]float64)
		}
		graph[pair.SrcToken][pair.DstToken] = weight

		log.Printf("Edge added: %s -> %s, weight: %f", pair.SrcToken, pair.DstToken, weight)
	}

	return graph, nil
}


// Decode transaction data (replace this ABI decoding logic with your contract's ABI)
func decodeTransactionData(data string) (string, string, *big.Int, error) {
	// Example ABI for decoding (replace with your contract ABI)
	parsedABI, err := abi.JSON(strings.NewReader(`[{
		"name":"swap",
		"inputs":[
			{"name":"srcToken","type":"address"},
			{"name":"dstToken","type":"address"},
			{"name":"amountIn","type":"uint256"}
		],
		"type":"function"
	}]`))
	if err != nil {
		return "", "", nil, fmt.Errorf("failed to parse ABI: %v", err)
	}

	methodSig := data[:10] // First 4 bytes represent the function signature
	inputData := common.FromHex(data)

	// Decode the transaction data using the ABI
	method, err := parsedABI.MethodById([]byte(methodSig))
	if err != nil {
		return "", "", nil, fmt.Errorf("failed to decode method ID: %v", err)
	}

	args := make(map[string]interface{})
	err = method.Inputs.UnpackIntoMap(args, inputData[4:])
	if err != nil {
		return "", "", nil, fmt.Errorf("failed to unpack inputs: %v", err)
	}

	srcToken, ok := args["srcToken"].(common.Address)
	if !ok {
		return "", "", nil, fmt.Errorf("invalid srcToken type")
	}

	dstToken, ok := args["dstToken"].(common.Address)
	if !ok {
		return "", "", nil, fmt.Errorf("invalid dstToken type")
	}

	amountIn, ok := args["amountIn"].(*big.Int)
	if !ok {
		return "", "", nil, fmt.Errorf("invalid amountIn type")
	}

	return srcToken.Hex(), dstToken.Hex(), amountIn, nil
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

	// Decode transaction data
	srcToken, dstToken, err := decodeTransactionData(tx.Data())
	if err != nil {
		log.Printf("Failed to decode transaction data: %v", err)
		return
	}

	log.Printf("Detected relevant transaction: %s", tx.Hash().Hex())

	// Simulate fetching quote and profit evaluation (replace with actual API calls)
	quoteAmount := "1000000000000000000" // Example quote amount (replace with real API call)
	profit := "5000000"                  // Example profit (replace with evaluation logic)

	if profit != "" {
		// Broadcast arbitrage opportunity via WebSocket
		wsBroadcast <- ArbitrageOpportunity{
			TxHash:   tx.Hash().Hex(),
			Profit:   profit,
			SrcToken: srcToken,
			DstToken: dstToken,
			AmountIn: quoteAmount,
		}
	}
}

// Monitor mempool for pending transactions
func monitorMempool(targetContracts map[string]bool, rpcURL string) {
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		log.Fatalf("Failed to connect to Ethereum client: %v", err)
	}

	log.Println("Connected to Ethereum client. Monitoring mempool...")

	// Subscribe to pending transactions
	pendingTxs := make(chan *types.Transaction)
	sub, err := client.SubscribePendingTransactions(context.Background(), pendingTxs)
	if err != nil {
		log.Fatalf("Failed to subscribe to pending transactions: %v", err)
	}

	defer sub.Unsubscribe()

	// Process transactions as they arrive
	for {
		select {
		case err := <-sub.Err():
			log.Printf("Subscription error: %v", err)
			time.Sleep(time.Second) // Retry with a delay
		case tx := <-pendingTxs:
			go processTransaction(client, tx, targetContracts) // Process each transaction in a goroutine
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

	resp, err := http.Post(apiURL, "application/json", strings.NewReader(string(jsonPayload)))
	if err != nil || resp.StatusCode != http.StatusOK {
		return fmt.Errorf("token approval API failed: %v", err)
	}
	defer resp.Body.Close()

	log.Println("Token approval completed successfully via Node.js API.")
	return nil
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

	resp, err := http.Post(apiURL, "application/json", strings.NewReader(string(jsonPayload)))
	if err != nil || resp.StatusCode != http.StatusOK {
		log.Printf("Notification API failed: %v", err)
		return
	}
	defer resp.Body.Close()

	log.Println("Notification sent successfully.")
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
		return big.NewInt(800000), nil // Fallback gas estimate
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

	// Send the HTTP request
	resp, err := http.Post(url, "application/json", bytes.NewBuffer(requestBody))
	if err != nil {
		return nil, fmt.Errorf("failed to send HTTP request: %v", err)
	}
	defer resp.Body.Close()

	// Check the HTTP response status
	if resp.StatusCode != http.StatusOK {
		// Read and log the response body
		bodyBytes, readErr := ioutil.ReadAll(resp.Body)
		if readErr != nil {
			log.Printf("Failed to read response body for non-200 status: %v", readErr)
		} else {
			log.Printf("Received non-200 response: %d, Body: %s", resp.StatusCode, string(bodyBytes))
		}
		return nil, fmt.Errorf("received non-200 response: %d", resp.StatusCode)
	}

	// Decode the JSON response
	var permitDetails PermitDetails
	if err := json.NewDecoder(resp.Body).Decode(&permitDetails); err != nil {
		return nil, fmt.Errorf("failed to decode response: %v", err)
	}

	return &permitDetails, nil
}

// Handle WebSocket connections
func wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Failed to upgrade to WebSocket: %v", err)
		return
	}

	// Register client
	wsClients[conn] = true
	defer func() {
		delete(wsClients, conn)
		conn.Close()
	}()

	// Listen for messages from the WebSocket (optional)
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			log.Printf("WebSocket error: %v", err)
			break
		}
	}
}

// Broadcast opportunities to WebSocket clients
func wsBroadcastManager() {
	for opportunity := range wsBroadcast {
		data, _ := json.Marshal(opportunity)
		for client := range wsClients {
			func(client *websocket.Conn) {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("Recovered from panic while sending WebSocket message: %v", r)
						client.Close()
						delete(wsClients, client)
					}
				}()

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
	// Define the target contracts to monitor
	targetContracts := map[string]bool{
		"0xE592427A0AEce92De3Edee1F18E0157C05861564": true, // Uniswap V3
		"0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F": true, // SushiSwap
	}

	// Fetch the RPC URL from environment variables
	rpcURL := os.Getenv("INFURA_WS_URL")
	if rpcURL == "" {
		log.Fatal("INFURA_WS_URL is not set")
	}

	// Create a context with cancel for shutdown handling
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Listen for interrupt signals to gracefully shut down
	go func() {
		c := make(chan os.Signal, 1)
		signal.Notify(c, os.Interrupt, syscall.SIGTERM)
		<-c
		log.Println("Received shutdown signal, cleaning up...")
		cancel() // Cancel the context to signal all goroutines to terminate
	}()

	// Start WebSocket broadcast manager in a separate goroutine
	go wsBroadcastManager()

	// Start the WebSocket server
	http.HandleFunc("/ws", wsHandler)
	go func() {
		log.Println("WebSocket server listening on :8080/ws")
		log.Fatal(http.ListenAndServe(":8080", nil))
	}()

	// Start monitoring the mempool in a separate goroutine
	go func() {
		monitorMempool(ctx, targetContracts, rpcURL)
	}()

	// Start the REST API server for route generation and dynamic graph building
	http.HandleFunc("/generate-routes", func(w http.ResponseWriter, r *http.Request) {
		chainID := int64(42161) // Ethereum Mainnet
		startToken := "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" // USDC address

		// Parse destination token and token pairs
		dstToken := r.URL.Query().Get("dstToken")
		if !isValidTokenAddress(dstToken) {
			http.Error(w, "Invalid destination token address", http.StatusBadRequest)
			return
		}

		// Example token pairs (in practice, this could be dynamically fetched or provided)
		tokenPairs := []TokenPair{
			{SrcToken: startToken, DstToken: dstToken},
			// Add other token pairs dynamically based on market data
		}

		// Build the graph dynamically using live market data
		graph, err := BuildGraph(tokenPairs, chainID)
		if err != nil {
			log.Printf("Error building graph: %v", err)
			http.Error(w, "Failed to build graph", http.StatusInternalServerError)
			return
		}

		// Compute the optimal route
		path, cost, err := ComputeOptimalRoute(graph, startToken, dstToken)
		if err != nil {
			log.Printf("Error computing optimal route: %v", err)
			http.Error(w, "Failed to compute optimal route", http.StatusInternalServerError)
			return
		}

		// Log and return the optimal route and cost
		log.Printf("Optimal route: %v, Total cost: %f", path, cost)
		w.Header().Set("Content-Type", "application/json")
		response := map[string]interface{}{
			"path": path,
			"cost": cost,
		}
		json.NewEncoder(w).Encode(response)
	})

	// Example usage of decodeTransactionData
	go func() {
		data := "0x12345678abcdef..." // Replace with actual data
		srcToken, dstToken, amountIn, err := decodeTransactionData(data)
		if err != nil {
			log.Fatalf("Error decoding transaction data: %v", err)
		}
		log.Printf("Decoded transaction: srcToken=%s, dstToken=%s, amountIn=%s", srcToken, dstToken, amountIn.String())
	}()

	// Example usage of fetchGasPrice
	go func() {
		gasPrice, err := fetchGasPrice()
		if err != nil {
			log.Fatalf("Error fetching gas price: %v", err)
		}
		log.Printf("Current gas price: %s Wei", gasPrice.String())
	}()

	// Final log before starting HTTP server
	log.Println("Starting HTTP server on :8080...")
	log.Fatal(http.ListenAndServe(":8080", nil))
}


// Helper function to validate token address
func isValidTokenAddress(address string) bool {
	// Replace with your token address validation logic (e.g., regex or lookup)
	return len(address) == 42 && address[:2] == "0x"
}
