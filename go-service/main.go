package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
        "math/big"
        "sync"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/gorilla/websocket"
)

type ArbitrageOpportunity struct {
	TxHash   string  `json:"txHash"`
	Profit   string  `json:"profit"`
	SrcToken string  `json:"srcToken"`
	DstToken string  `json:"dstToken"`
	AmountIn string  `json:"amountIn"`
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
	if !common.IsHexAddress(startToken) {
		return nil, fmt.Errorf("invalid start token address: %s", startToken)
	}

	stableTokens, err := getStableTokenList(chainID)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch stable tokens: %v", err)
	}

	validStableTokenAddresses := filterValidAddresses(stableTokens)
	if len(validStableTokenAddresses) == 0 {
		return nil, fmt.Errorf("no valid stable token addresses available")
	}

	tokenPairs := generateTokenPairs(validStableTokenAddresses)
	graph, err := buildGraph(tokenPairs, chainID)
	if err != nil {
		return nil, fmt.Errorf("failed to build graph: %v", err)
	}

	averageLiquidity, err := calculateAverageLiquidity(validStableTokenAddresses, chainID, startToken)
	if err != nil {
		return nil, fmt.Errorf("failed to calculate average liquidity: %v", err)
	}

	maxHops = adjustMaxHops(maxHops, averageLiquidity)

	var profitableRoutes []Route
	var mu sync.Mutex
	var wg sync.WaitGroup

	for _, endToken := range validStableTokenAddresses {
		if strings.EqualFold(endToken, startToken) {
			continue
		}

		wg.Add(1)
		go func(endToken string) {
			defer wg.Done()
			path, cost, err := findOptimalRoute(graph, startToken, endToken)
			if err != nil || len(path) <= 1 {
				return
			}

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
	return sortAndLimitRoutes(profitableRoutes, 3), nil
}

func getStableTokenList(chainID int64) ([]StableToken, error) {
	// Replace with actual API call to fetch stable tokens
	return []StableToken{
		{"0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"}, // Example USDT
		{"0xaf88d065e77c8cC2239327C5EDb3A432268e5831"}, // Example USDC
	}, nil
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

func calculateAverageLiquidity(tokens []string, chainID int64, startToken string) (*big.Float, error) {
	// Mock implementation. Replace with real API call.
	return big.NewFloat(1000000), nil
}

func adjustMaxHops(maxHops int, avgLiquidity *big.Float) int {
	if avgLiquidity.Cmp(big.NewFloat(10000000)) > 0 {
		return min(maxHops+1, 4)
	} else if avgLiquidity.Cmp(big.NewFloat(500000)) < 0 {
		return max(maxHops-1, 1)
	}
	return maxHops
}

func findOptimalRoute(graph *Graph, startToken, endToken string) ([]string, *big.Int, error) {
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


// WebSocket connection manager
var wsClients = make(map[*websocket.Conn]bool)

// Global WebSocket Broadcast Channel
var wsBroadcast = make(chan ArbitrageOpportunity)

// Decode transaction data (replace this ABI decoding logic with your contract's ABI)
func decodeTransactionData(data string) (string, string, error) {
	// Example ABI for decoding (replace with your contract ABI)
	parsedABI, err := abi.JSON(strings.NewReader(`[{"name":"swap","inputs":[{"name":"srcToken","type":"address"},{"name":"dstToken","type":"address"}],"type":"function"}]`))
	if err != nil {
		return "", "", fmt.Errorf("failed to parse ABI: %v", err)
	}

	methodSig := data[:10] // First 4 bytes represent the function signature
	inputData := common.FromHex(data)

	// Decode the transaction data using the ABI
	method, err := parsedABI.MethodById([]byte(methodSig))
	if err != nil {
		return "", "", fmt.Errorf("failed to decode method ID: %v", err)
	}

	args := make(map[string]interface{})
	err = method.Inputs.UnpackIntoMap(args, inputData[4:])
	if err != nil {
		return "", "", fmt.Errorf("failed to unpack inputs: %v", err)
	}

	srcToken := args["srcToken"].(common.Address).Hex()
	dstToken := args["dstToken"].(common.Address).Hex()

	return srcToken, dstToken, nil
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
			err := client.WriteMessage(websocket.TextMessage, data)
			if err != nil {
				log.Printf("WebSocket send error: %v", err)
				client.Close()
				delete(wsClients, client)
			}
		}
	}
}

func main() {

        http.HandleFunc("/generate-routes", generateRoutesHandler)
	log.Println("Starting server on :8080...")
	log.Fatal(http.ListenAndServe(":8080", nil))
	// Define the target contracts to monitor
	targetContracts := map[string]bool{
		"0xE592427A0AEce92De3Edee1F18E0157C05861564": true, // Uniswap V3
		"0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F": true, // SushiSwap
	}

	rpcURL := os.Getenv("INFURA_WS_URL")
	if rpcURL == "" {
		log.Fatal("INFURA_WS_URL is not set")
	}

	// Start the WebSocket broadcast manager
	go wsBroadcastManager()

	// Start the WebSocket server
	http.HandleFunc("/ws", wsHandler)
	go func() {
		log.Println("WebSocket server listening on :8080/ws")
		log.Fatal(http.ListenAndServe(":8080", nil))
	}()

	// Start monitoring the mempool
	monitorMempool(targetContracts, rpcURL)
}

