import java.util.Scanner;

public class Activity4F {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        Tree tree = new Tree();

        tree.root = new Node(4);
        tree.root.left = new Node(1);
        tree.root.right = new Node(8);
        tree.root.left.left = new Node(25);
        tree.root.left.right = new Node(28);
        tree.root.right.left = new Node(10);
        tree.root.right.right = new Node(7);
        tree.root.left.left.left = new Node(42);
        tree.root.left.left.right = new Node(3);
        tree.root.left.right.left = new Node(11);
        tree.root.left.right.right = new Node(45);
        tree.root.right.left.left = new Node(55);
        tree.root.right.left.right = new Node(65);
        tree.root.right.right.left = new Node(75);
        tree.root.right.right.right = new Node(90);

        int choice;
        do {
            System.out.println("\n===== Binary Tree Traversal =====");
            System.out.println("[1] Inorder");
            System.out.println("[2] Preorder");
            System.out.println("[3] Postorder");
            System.out.println("[4] Exit");
            System.out.print("Enter your choice: ");
            choice = sc.nextInt();

            switch (choice) {
                case 1:
                    System.out.println("\nInorder Traversal");
                    tree.first = true;
                    tree.inOrder(tree.root);
                    System.out.println();
                    break;
                case 2:
                    System.out.println("\nPreorder Traversal");
                    tree.first = true;
                    tree.preOrder(tree.root);
                    System.out.println();
                    break;
                case 3:
                    System.out.println("\nPostorder Traversal");
                    tree.first = true;
                    tree.postOrder(tree.root);
                    System.out.println();
                    break;
                case 4:
                    System.out.println("\nProgram ended.");
                    break;
                default:
                    System.out.println("\nInvalid choice, try again.");
            }

        } while (choice != 4);

        sc.close();
    }
}

class Node {
    int item;
    Node left, right;

    public Node(int key) {
        item = key;
        left = right = null;
    }
}

class Tree {
    Node root;

    boolean first = true;

    Tree() {
        root = null;
    }

    void printItem(int item) {
        if (first) {
            System.out.print("" + item);
            first = false;
        } else {
            System.out.print(", " + item);
        }
    }


    void inOrder(Node node) {
        if (node == null)
            return;

        inOrder(node.left);
        printItem(node.item);
        inOrder(node.right);
    }


    void preOrder(Node node) {
        if (node == null)
            return;

        printItem(node.item);
        preOrder(node.left);
        preOrder(node.right);
    }


    void postOrder(Node node) {
        if (node == null)
            return;

        postOrder(node.left);
        postOrder(node.right);
        printItem(node.item);
    }
}
