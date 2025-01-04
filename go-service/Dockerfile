# Use the official Golang image with Go 1.20
FROM golang:1.20

# Set the working directory inside the container
WORKDIR /app

# Clean Go module cache
RUN go clean -modcache

# Copy only go.mod and go.sum to leverage Docker caching
COPY go.mod go.sum ./


# Ensure go.mod and go.sum are up to date
RUN go mod tidy && go mod download

# Copy the entire project code into the container
COPY . .

# Build the Go application
RUN go build -o app

# Set the default command to run the app
CMD ["./app"]

