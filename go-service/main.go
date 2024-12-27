package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
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

