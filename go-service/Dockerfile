# Use the official Golang image with Go 1.20
FROM golang:1.20

# Set the working directory inside the container
WORKDIR /app

# Clean module cache and download dependencies
RUN go clean -modcache

# Copy only go.mod and go.sum first to leverage Docker caching
COPY ./go-service/go.mod ./go-service/go.sum ./

# Enable Go modules
ENV GO111MODULE=on

# Download Go module dependencies
RUN go mod download

# Copy the entire project code into the container
COPY ./go-service/. .

# Build the Go application
RUN go build -o app main.go

# Set the default command to run the app
CMD ["./app"]

